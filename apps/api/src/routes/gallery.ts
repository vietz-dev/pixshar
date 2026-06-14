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

const app = new Hono<{ Variables: HonoVariables }>();

const secret = new TextEncoder().encode(env.BETTER_AUTH_SECRET);

const unlockSchema = z.object({
  password: z.string().min(1),
});

app.post("/:slug/unlock", zValidator("json", unlockSchema), async (c) => {
  const slug = c.req.param("slug");
  const body = c.req.valid("json");

  const event = await prisma.event.findUnique({ where: { slug } });
  if (!event) {
    return c.json({ error: "Gallery not found" }, 404);
  }

  if (event.passwordHash !== body.password) {
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
  const photographerName = form.get("photographerName") as string;

  if (!files.length) {
    return c.json({ error: "No files provided" }, 400);
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

export default app;
