import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getPresignedUrl } from "../lib/s3.js";
import { requireGallerySession } from "../middleware/requireGallerySession.js";
import { SignJWT } from "jose";
import { env } from "../lib/env.js";
import { getCookie, setCookie } from "hono/cookie";
import { processImage } from "../services/imageProcessor.js";
import { Effect } from "effect";
import type { HonoVariables } from "../types.js";
import { verifyPassword } from "../lib/hash.js";
import { checkRateLimit, getRateLimitKey } from "../lib/rateLimit.js";
import { validateFiles } from "../lib/validate.js";

const app = new Hono<{ Variables: HonoVariables }>();

const secret = new TextEncoder().encode(env.BETTER_AUTH_SECRET);

const unlockSchema = z.object({
  password: z.string().min(1).max(128),
});

app.post("/:slug/unlock", zValidator("json", unlockSchema), async (c) => {
  const slug = c.req.param("slug");
  const body = c.req.valid("json");

  const event = await prisma.event.findUnique({ where: { slug } });
  if (!event) {
    return c.json({ error: "Gallery not found" }, 404);
  }

  // Rate limit: 5 attempts per minute per IP
  const rateKey = getRateLimitKey(c, `unlock:${slug}`);
  if (!checkRateLimit(rateKey, 5, 60_000)) {
    return c.json({ error: "Too many attempts. Please try again later." }, 429);
  }

  let valid = false;
  if (event.passwordHash.includes(":")) {
    // New format: hashed with scrypt
    valid = await verifyPassword(body.password, event.passwordHash);
  } else {
    // Legacy format: plaintext (migration fallback)
    valid = event.passwordHash === body.password;
  }

  if (!valid) {
    return c.json({ error: "Invalid password" }, 401);
  }

  const token = await new SignJWT({ eventId: event.id })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(secret);

  setCookie(c, `gallery_${slug}`, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });

  return c.json({ success: true });
});

app.get("/:slug", requireGallerySession, async (c) => {
  const event = c.get("galleryEvent");
  const photos = await prisma.photo.findMany({
    where: { eventId: event.id, status: "PROCESSED" },
    orderBy: { createdAt: "desc" },
  });

  const photosWithUrls = await Promise.all(
    photos.map(async (photo: typeof photos[0]) => ({
      id: photo.id,
      photographerName: photo.photographerName,
      thumbUrl: await getPresignedUrl(photo.thumbKey, "get", 3600),
      displayUrl: await getPresignedUrl(photo.displayKey, "get", 3600),
      status: photo.status,
    }))
  );

  return c.json({
    id: event.id,
    slug: event.slug,
    name: event.name,
    description: event.description,
    photos: photosWithUrls,
  });
});

app.post("/:slug/upload", requireGallerySession, async (c) => {
  const event = c.get("galleryEvent");
  const form = await c.req.formData();
  const files = form.getAll("files") as File[];
  const photographerNameRaw = form.get("photographerName") as string;
  const photographerName = photographerNameRaw ? photographerNameRaw.trim().slice(0, 100) : null;

  if (photographerNameRaw && photographerNameRaw.trim().length > 100) {
    return c.json({ error: "Photographer name must be 100 characters or less" }, 400);
  }

  if (!files.length) {
    return c.json({ error: "No files provided" }, 400);
  }

  // Rate limit: 50 uploads per minute per gallery
  const rateKey = getRateLimitKey(c, `upload:${event.id}`);
  if (!checkRateLimit(rateKey, 50, 60_000)) {
    return c.json({ error: "Too many uploads. Please try again later." }, 429);
  }

  const validation = validateFiles(files);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const results = await Promise.all(
    files.map(async (file) => {
      const buffer = Buffer.from(await file.arrayBuffer());
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const cleanExt = ext === "png" ? "png" : "jpg";

      const photo = await prisma.photo.create({
        data: {
          eventId: event.id,
          photographerName: photographerName || null,
          originalKey: "",
          displayKey: "",
          thumbKey: "",
          status: "PENDING",
          uploadedBy: "GUEST",
        },
      });

      Effect.runFork(processImage({
        photoId: photo.id,
        buffer,
        eventId: event.id,
        ext: cleanExt,
      }));

      return { id: photo.id, status: "PENDING" };
    })
  );

  return c.json({ photos: results }, 202);
});

app.get("/:slug/download", requireGallerySession, async (c) => {
  const event = await prisma.event.findUnique({
    where: { slug: c.req.param("slug") },
    include: { downloadJob: true },
  });

  if (!event) {
    return c.json({ error: "Gallery not found" }, 404);
  }

  const job = event.downloadJob;

  if (!job) {
    return c.json({
      status: "NONE",
      message: "No archive available yet.",
    });
  }

  if (job.status === "DEBOUNCING") {
    return c.json({
      status: "DEBOUNCING",
      message: "New photos are still being uploaded. Your archive will be ready shortly.",
      debounceUntil: job.debounceUntil,
    });
  }

  if (job.status === "QUEUED" || job.status === "BUILDING") {
    return c.json({
      status: "BUILDING",
      message: "Your archive is being prepared. This may take a few minutes.",
      photoCount: job.photoCount,
      processedPhotos: job.processedPhotos,
      uploadProgress: job.uploadProgress,
    });
  }

  if (job.status === "FAILED" || job.status === "CANCELLED") {
    return c.json({
      status: "FAILED",
      message: "Archive generation failed. Please try again later.",
    });
  }

  // READY — generate presigned URL
  const url = await getPresignedUrl(job.zipKey!, "get", 60 * 60); // 1 hour
  const sizeBytes = job.zipSizeBytes ?? 0;

  return c.json({
    status: "READY",
    url,
    sizeBytes,
    photoCount: job.photoCount,
  });
});

app.get("/:slug/photos/:photoId/download", requireGallerySession, async (c) => {
  const event = c.get("galleryEvent");
  const photoId = c.req.param("photoId");

  const photo = await prisma.photo.findUnique({
    where: { id: photoId, eventId: event.id },
  });
  if (!photo) {
    return c.json({ error: "Photo not found" }, 404);
  }

  const filename = `${(photo.photographerName || "photo").replace(/[^a-zA-Z0-9_-]/g, "_")}-${photo.id}.jpg`;
  const url = await getPresignedUrl(
    photo.originalKey,
    "get",
    60 * 60,
    `attachment; filename="${filename}"`
  );
  return c.json({ url });
});

export default app;
