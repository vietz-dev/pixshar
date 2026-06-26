import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { s3, deleteS3Object, getPresignedUrl } from "../lib/s3.js";
import { env } from "../lib/env.js";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { HonoVariables } from "../types.js";
import { getDownloadJobStatus, forceBuild, cancelJob, statusMessage } from "../services/downloadJob.js";
import { streamSSE } from "hono/streaming";
import { onDownloadStatus } from "../lib/eventBus.js";
import { hashPassword } from "../lib/hash.js";
import { checkRateLimit, getRateLimitKey } from "../lib/rateLimit.js";

const app = new Hono<{ Variables: HonoVariables }>();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  description: z.string().max(1000).optional(),
  password: z.string().min(1).max(128),
});

app.get("/", requireAdmin, async (c) => {
  // Rate limit: 60 list requests per minute per IP
  const rateKey = getRateLimitKey(c, "list-events");
  if (!checkRateLimit(rateKey, 60, 60_000)) {
    return c.json({ error: "Too many requests. Please try again later." }, 429);
  }

  const events = await prisma.event.findMany({
    orderBy: { createdAt: "desc" },
    omit: { passwordHash: true },
    include: {
      _count: { select: { photos: true } },
    },
  });
  return c.json(events);
});

app.post("/", requireAdmin, zValidator("json", createSchema), async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user");

  // Rate limit: 10 event creations per minute per IP
  const rateKey = getRateLimitKey(c, "create-event");
  if (!checkRateLimit(rateKey, 10, 60_000)) {
    return c.json({ error: "Too many requests. Please try again later." }, 429);
  }

  const existing = await prisma.event.findUnique({ where: { slug: body.slug } });
  if (existing) {
    return c.json({ error: "Slug already exists" }, 409);
  }

  const hashedPassword = await hashPassword(body.password);

  const event = await prisma.event.create({
    data: {
      name: body.name,
      slug: body.slug,
      description: body.description || null,
      passwordHash: hashedPassword,
      createdById: user.id,
      status: "READY",
    },
    omit: { passwordHash: true },
  });

  return c.json(event, 201);
});

app.get("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  // Rate limit: 60 detail requests per minute per event
  const rateKey = getRateLimitKey(c, `event-detail:${id}`);
  if (!checkRateLimit(rateKey, 60, 60_000)) {
    return c.json({ error: "Too many requests. Please try again later." }, 429);
  }

  const event = await prisma.event.findUnique({
    where: { id },
    omit: { passwordHash: true },
    include: { photos: { orderBy: { createdAt: "desc" } } },
  });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const photosWithUrls = await Promise.all(
    event.photos.map(async (photo: typeof event.photos[0]) => ({
      ...photo,
      thumbUrl: photo.thumbKey ? await getPresignedUrl(photo.thumbKey, "get", 3600) : "",
      displayUrl: photo.displayKey ? await getPresignedUrl(photo.displayKey, "get", 3600) : "",
    }))
  );

  return c.json({ ...event, photos: photosWithUrls });
});

app.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const event = await prisma.event.findUnique({
    where: { id },
    include: { photos: true },
  });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Delete all S3 objects under the event prefix
  try {
    const prefix = `${event.id}/`;
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: prefix,
      })
    );
    if (list.Contents) {
      for (const obj of list.Contents) {
        if (obj.Key) {
          await deleteS3Object(obj.Key);
        }
      }
    }
  } catch {
    // S3 cleanup failed, continue with DB delete
  }

  await prisma.event.delete({ where: { id } });
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Download archive admin endpoints
// ---------------------------------------------------------------------------

app.get("/:id/download/status", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  // Rate limit: 60 status checks per minute per event
  const rateKey = getRateLimitKey(c, `admin-download-status:${id}`);
  if (!checkRateLimit(rateKey, 60, 60_000)) {
    return c.json({ error: "Too many requests. Please try again later." }, 429);
  }

  const event = await prisma.event.findUnique({
    where: { id },
    include: { downloadJob: true },
  });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const job = event.downloadJob;
  if (!job) {
    return c.json({
      status: "NONE",
      message: "No archive created yet.",
      processedPhotos: 0,
      photoCount: 0,
    });
  }

  const totalPhotos = await prisma.photo.count({
    where: { eventId: id, status: "PROCESSED" },
  });

  return c.json({
    status: job.status,
    message: statusMessage(job.status),
    photoCount: job.photoCount,
    processedPhotos: job.processedPhotos,
    uploadProgress: job.uploadProgress,
    totalPhotos,
    zipSizeBytes: job.zipSizeBytes,
    debounceUntil: job.debounceUntil,
    failureReason: job.failureReason,
    updatedAt: job.updatedAt,
  });
});

app.get("/:id/download/status/stream", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const event = await prisma.event.findUnique({
    where: { id },
    include: { downloadJob: true },
  });
  if (!event) return c.json({ error: "Event not found" }, 404);
  if (event.createdById !== user.id) return c.json({ error: "Forbidden" }, 403);

  return streamSSE(c, async (stream) => {
    const job = event.downloadJob;
    const totalPhotos = await prisma.photo.count({ where: { eventId: id, status: "PROCESSED" } });

    const initial = job
      ? {
          status: job.status,
          message: statusMessage(job.status),
          photoCount: job.photoCount,
          processedPhotos: job.processedPhotos,
          uploadProgress: job.uploadProgress,
          totalPhotos,
          zipSizeBytes: job.zipSizeBytes,
          debounceUntil: job.debounceUntil?.toISOString() ?? null,
          failureReason: job.failureReason,
          updatedAt: job.updatedAt.toISOString(),
        }
      : { status: "NONE", message: statusMessage("NONE"), photoCount: 0, processedPhotos: 0, uploadProgress: 0, totalPhotos, zipSizeBytes: null, debounceUntil: null, failureReason: null, updatedAt: new Date().toISOString() };

    await stream.writeSSE({ data: JSON.stringify(initial), event: "download-status" });

    const unsubscribe = onDownloadStatus(id, async (payload) => {
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

app.post("/:id/download/build", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await forceBuild(id);
  return c.json({ success: true });
});

app.post("/:id/download/cancel", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await cancelJob(id);
  return c.json({ success: true });
});

app.get("/:id/photos/:photoId/download", requireAdmin, async (c) => {
  const eventId = c.req.param("id");
  const photoId = c.req.param("photoId");
  const user = c.get("user");

  // Rate limit: 60 photo downloads per minute per event
  const rateKey = getRateLimitKey(c, `admin-photo-dl:${eventId}`);
  if (!checkRateLimit(rateKey, 60, 60_000)) {
    return c.json({ error: "Too many requests. Please try again later." }, 429);
  }

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event || event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const photo = await prisma.photo.findUnique({
    where: { id: photoId, eventId },
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

app.delete("/:id/photos/:photoId", requireAdmin, async (c) => {
  const eventId = c.req.param("id");
  const photoId = c.req.param("photoId");
  const user = c.get("user");

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event || event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const photo = await prisma.photo.findUnique({
    where: { id: photoId, eventId },
  });
  if (!photo) {
    return c.json({ error: "Photo not found" }, 404);
  }

  // Delete S3 objects
  const keys = [photo.originalKey, photo.displayKey, photo.thumbKey].filter(Boolean);
  for (const key of keys) {
    if (key) {
      await deleteS3Object(key).catch(() => {});
    }
  }

  await prisma.photo.delete({ where: { id: photoId } });
  return c.json({ success: true });
});

export default app;
