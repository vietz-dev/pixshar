import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getPresignedUrl } from "../lib/s3.js";
import { requireGallerySession } from "../middleware/requireGallerySession.js";
import { SignJWT } from "jose";
import { env } from "../lib/env.js";
import { getCookie, setCookie } from "hono/cookie";
import type { HonoVariables } from "../types.js";
import { verifyPassword } from "../lib/hash.js";
import { checkRateLimit, getRateLimitKey } from "../lib/rateLimit.js";
import {
  initUpload,
  completeUpload,
  uploadInitSchema,
  uploadCompleteSchema,
} from "../lib/uploadInit.js";
import { streamSSE } from "hono/streaming";
import { onDownloadStatus } from "../lib/eventBus.js";

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

  const valid = await verifyPassword(body.password, event.passwordHash);
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
  // Rate limit: 120 requests per minute per gallery
  const rateKey = getRateLimitKey(c, `gallery-get:${c.req.param("slug")}`);
  if (!checkRateLimit(rateKey, 120, 60_000)) {
    return c.json({ error: "Too many requests. Please try again later." }, 429);
  }

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

// Step 1 — dedup + presigned PUT URLs for guest uploads (direct browser → S3).
app.post(
  "/:slug/upload/init",
  requireGallerySession,
  zValidator("json", uploadInitSchema),
  async (c) => {
    const event = c.get("galleryEvent");

    // Rate limit: 50 init requests per minute per gallery
    const rateKey = getRateLimitKey(c, `upload:${event.id}`);
    if (!checkRateLimit(rateKey, 50, 60_000)) {
      return c.json({ error: "Too many uploads. Please try again later." }, 429);
    }

    const { files, photographerName } = c.req.valid("json");
    const name = photographerName?.trim().slice(0, 100) || null;

    const photos = await initUpload({
      eventId: event.id,
      uploadedBy: "GUEST",
      photographerName: name,
      files,
    });
    return c.json({ photos }, 200);
  }
);

// Step 2 — confirm uploads landed in S3, start processing.
app.post(
  "/:slug/upload/complete",
  requireGallerySession,
  zValidator("json", uploadCompleteSchema),
  async (c) => {
    const event = c.get("galleryEvent");
    const { photoIds } = c.req.valid("json");
    await completeUpload(event.id, photoIds);
    return c.json({ ok: true }, 202);
  }
);

app.get("/:slug/download", requireGallerySession, async (c) => {
  // Rate limit: 30 download checks per minute per gallery
  const rateKey = getRateLimitKey(c, `download-check:${c.req.param("slug")}`);
  if (!checkRateLimit(rateKey, 30, 60_000)) {
    return c.json({ error: "Too many requests. Please try again later." }, 429);
  }

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

app.get("/:slug/download/stream", requireGallerySession, async (c) => {
  const event = c.get("galleryEvent");

  return streamSSE(c, async (stream) => {
    const fullEvent = await prisma.event.findUnique({
      where: { id: event.id },
      include: { downloadJob: true },
    });
    const job = fullEvent?.downloadJob ?? null;

    async function buildInitialPayload() {
      if (!job) {
        return { status: "NONE", message: "No archive available yet." };
      }
      if (job.status === "DEBOUNCING") {
        return {
          status: "DEBOUNCING",
          message: "New photos are still being uploaded. Your archive will be ready shortly.",
          debounceUntil: job.debounceUntil?.toISOString() ?? null,
        };
      }
      if (job.status === "QUEUED" || job.status === "BUILDING") {
        return {
          status: "BUILDING",
          message: "Your archive is being prepared. This may take a few minutes.",
          photoCount: job.photoCount,
          processedPhotos: job.processedPhotos,
          uploadProgress: job.uploadProgress,
        };
      }
      if (job.status === "FAILED" || job.status === "CANCELLED") {
        return { status: "FAILED", message: "Archive generation failed. Please try again later." };
      }
      // READY
      const url = await getPresignedUrl(job.zipKey!, "get", 60 * 60);
      return { status: "READY", url, sizeBytes: job.zipSizeBytes ?? 0, photoCount: job.photoCount };
    }

    await stream.writeSSE({ data: JSON.stringify(await buildInitialPayload()), event: "download-status" });

    const unsubscribe = onDownloadStatus(event.id, async (payload) => {
      // Guest view needs a slightly different shape: remap to gallery format
      if (payload.status === "READY") {
        // Presigned URL must be generated fresh here
        const fullJob = await prisma.downloadJob.findUnique({ where: { eventId: event.id } });
        if (fullJob?.zipKey) {
          const url = await getPresignedUrl(fullJob.zipKey, "get", 60 * 60);
          await stream.writeSSE({
            data: JSON.stringify({ status: "READY", url, sizeBytes: fullJob.zipSizeBytes ?? 0, photoCount: fullJob.photoCount }),
            event: "download-status",
          });
          return;
        }
      }
      await stream.writeSSE({ data: JSON.stringify(payload), event: "download-status" });
    });

    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: "ping", event: "keep-alive" }).catch(() => {});
    }, 30_000);

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        unsubscribe();
        clearInterval(keepAlive);
        resolve();
      });
    });
  });
});

app.get("/:slug/photos/:photoId/download", requireGallerySession, async (c) => {
  // Rate limit: 60 photo downloads per minute per gallery
  const rateKey = getRateLimitKey(c, `photo-dl:${c.req.param("slug")}`);
  if (!checkRateLimit(rateKey, 60, 60_000)) {
    return c.json({ error: "Too many requests. Please try again later." }, 429);
  }

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
