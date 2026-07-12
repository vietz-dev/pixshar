import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { s3, deleteS3Object, getPresignedUrl } from "../lib/s3.js";
import { env } from "../lib/env.js";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { HonoVariables } from "../types.js";
import { buildNow, rebuildAll, cancelJob, releaseArchive, triggerReconcileAllVariants, statusMessage } from "../services/downloadJob.js";
import { getBoss } from "../lib/pgboss.js";
import { streamSSE } from "hono/streaming";
import { onDownloadStatus } from "../lib/eventBus.js";
import { hashPassword } from "../lib/hash.js";
import { encryptPassword, decryptPassword } from "../lib/crypto.js";
import { checkRateLimit, getRateLimitKey } from "../lib/rateLimit.js";
import { photoDownloadsTotal, archiveDownloadsTotal } from "../lib/metrics.js";

const app = new Hono<{ Variables: HonoVariables }>();

// Admin download endpoints act on one variant, selected by ?quality=. Defaults
// to ORIGINAL (the historical single archive) so pre-variant callers are
// unchanged; the guest-facing default variant is DISPLAY (Kompakt).
type Quality = "DISPLAY" | "ORIGINAL";
function parseQuality(c: { req: { query: (k: string) => string | undefined } }): Quality {
  return c.req.query("quality") === "DISPLAY" ? "DISPLAY" : "ORIGINAL";
}

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

  // Rate limit: 50 event creations per minute per IP
  const rateKey = getRateLimitKey(c, "create-event");
  if (!checkRateLimit(rateKey, 50, 60_000)) {
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
      password: encryptPassword(body.password),
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

  const decryptedPassword = event.password ? decryptPassword(event.password) : null;
  return c.json({ ...event, password: decryptedPassword, photos: photosWithUrls });
});

app.patch("/:id/password", requireAdmin, zValidator("json", z.object({ password: z.string().min(1).max(128) })), async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const { password } = c.req.valid("json");

  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const passwordHash = await hashPassword(password);
  await prisma.event.update({
    where: { id },
    data: { password: encryptPassword(password), passwordHash },
  });

  return c.json({ success: true });
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

  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const quality = parseQuality(c);
  const job = await prisma.downloadJob.findUnique({
    where: { eventId_quality: { eventId: id, quality } },
  });
  const totalPhotos = await prisma.photo.count({
    where: { eventId: id, status: "PROCESSED" },
  });

  if (!job) {
    return c.json({
      quality,
      status: "NONE",
      message: "No archive created yet.",
      processedPhotos: 0,
      photoCount: 0,
      uploadProgress: 0,
      totalPhotos,
      totalSizeBytes: null,
      partCount: 0,
      debounceUntil: null,
      failureReason: null,
      lastDownloadedAt: null,
      updatedAt: new Date().toISOString(),
    });
  }

  return c.json({
    quality: job.quality,
    status: job.status,
    message: statusMessage(job.status),
    photoCount: job.photoCount,
    processedPhotos: job.processedPhotos,
    uploadProgress: job.uploadProgress,
    totalPhotos,
    totalSizeBytes: job.totalSizeBytes === null ? null : Number(job.totalSizeBytes),
    partCount: job.partCount,
    debounceUntil: job.debounceUntil,
    failureReason: job.failureReason,
    // The idle clock — stamped only by the guest part-redirect endpoint, never
    // by opening the download page.
    lastDownloadedAt: job.lastDownloadedAt,
    updatedAt: job.updatedAt,
  });
});

app.get("/:id/download/status/stream", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) return c.json({ error: "Event not found" }, 404);
  if (event.createdById !== user.id) return c.json({ error: "Forbidden" }, 403);

  const quality = parseQuality(c);

  return streamSSE(c, async (stream) => {
    const job = await prisma.downloadJob.findUnique({
      where: { eventId_quality: { eventId: id, quality } },
    });
    const totalPhotos = await prisma.photo.count({ where: { eventId: id, status: "PROCESSED" } });

    const initial = job
      ? {
          quality: job.quality,
          status: job.status,
          message: statusMessage(job.status),
          photoCount: job.photoCount,
          processedPhotos: job.processedPhotos,
          uploadProgress: job.uploadProgress,
          totalPhotos,
          totalSizeBytes: job.totalSizeBytes === null ? null : Number(job.totalSizeBytes),
          partCount: job.partCount,
          debounceUntil: job.debounceUntil?.toISOString() ?? null,
          failureReason: job.failureReason,
          updatedAt: job.updatedAt.toISOString(),
        }
      : { quality, status: "NONE", message: statusMessage("NONE"), photoCount: 0, processedPhotos: 0, uploadProgress: 0, totalPhotos, totalSizeBytes: null, partCount: 0, debounceUntil: null, failureReason: null, updatedAt: new Date().toISOString() };

    await stream.writeSSE({ data: JSON.stringify(initial), event: "download-status" });

    // Both variants emit on the same per-event bus key; forward only this
    // stream's variant so each admin panel gets an independent feed.
    const unsubscribe = onDownloadStatus(id, async (payload) => {
      if (payload.quality !== quality) return;
      await stream.writeSSE({ data: JSON.stringify(payload), event: "download-status" });
    });

    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: "ping", event: "keep-alive" }).catch(() => {});
    }, 15_000);

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        unsubscribe();
        clearInterval(keepAlive);
        resolve();
      });
    });
  });
});

// Skip the debounce wait and queue the pending reconcile now. Still routes
// through the FIFO build queue (respects worker/image-processor load).
app.post("/:id/download/build-now", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await buildNow(id, parseQuality(c));
  return c.json({ success: true });
});

// Rebuild every existing part's ZIP bytes, preserving each part's membership.
app.post("/:id/download/rebuild-all", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await rebuildAll(id, parseQuality(c));
  return c.json({ success: true });
});

// Release the archive: reclaim this variant's S3 objects now instead of waiting
// for the idle reaper. Runs the same expireArchive() the reaper runs — the
// membership survives, so the next request rebuilds the identical parts.
// `released: false` means there were no bytes to reclaim (not READY).
app.post("/:id/download/release", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }
  try {
    const released = await releaseArchive(id, parseQuality(c));
    return c.json({ success: true, released });
  } catch {
    return c.json({ error: "Failed to release archive" }, 500);
  }
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
  await cancelJob(id, parseQuality(c));
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
  photoDownloadsTotal.inc({ actor: "admin" });
  return c.json({ url });
});

// Re-queue all FAILED photos for an event. Reuses the existing rows (originals
// still in S3, except invalid ones which will re-fail cleanly).
app.post("/:id/photos/retry", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const failedPhotos = await prisma.photo.findMany({
    where: { eventId: id, status: "FAILED" },
    select: { id: true },
  });

  const res = await prisma.photo.updateMany({
    where: { eventId: id, status: "FAILED" },
    data: {
      status: "PENDING",
      attempts: 0,
      lastError: null,
    },
  });

  const boss = getBoss();
  await Promise.all(
    failedPhotos.map((p) =>
      boss.send(
        "photo-resize",
        { photoId: p.id },
        {
          singletonKey: p.id,
          retryLimit: env.PROCESS_MAX_ATTEMPTS - 1,
          retryDelay: 10,
          retryBackoff: true,
        }
      )
    )
  );
  return c.json({ success: true, requeued: res.count });
});

app.patch(
  "/:id/photos",
  requireAdmin,
  zValidator(
    "json",
    z.object({
      photoIds: z.array(z.string().min(1)).min(1),
      photographerName: z.string().max(100),
    })
  ),
  async (c) => {
    const eventId = c.req.param("id");
    const user = c.get("user");
    const { photoIds, photographerName } = c.req.valid("json");

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event || event.createdById !== user.id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const result = await prisma.photo.updateMany({
      where: { id: { in: photoIds }, eventId },
      data: { photographerName: photographerName.trim() || null },
    });

    return c.json({ success: true, updated: result.count });
  }
);

app.delete(
  "/:id/photos",
  requireAdmin,
  zValidator("json", z.object({ photoIds: z.array(z.string().min(1)).min(1) })),
  async (c) => {
    const eventId = c.req.param("id");
    const user = c.get("user");
    const { photoIds } = c.req.valid("json");

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event || event.createdById !== user.id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const photos = await prisma.photo.findMany({
      where: { id: { in: photoIds }, eventId },
      select: { id: true, originalKey: true, displayKey: true, thumbKey: true },
    });

    await Promise.all(
      photos.flatMap((p) =>
        [p.originalKey, p.displayKey, p.thumbKey]
          .filter(Boolean)
          .map((key) => deleteS3Object(key as string).catch(() => {}))
      )
    );

    await prisma.photo.deleteMany({
      where: { id: { in: photos.map((p) => p.id) }, eventId },
    });

    await staleArchivePartsForPhotos(eventId, photos.map((p) => p.id));

    return c.json({ success: true, deleted: photos.length });
  }
);

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

  await staleArchivePartsForPhotos(eventId, [photoId]);

  return c.json({ success: true });
});

// When photos inside already-built (immutable) archive parts are deleted, those
// parts must be rebuilt to drop the deleted images. Mark exactly the affected
// parts STALE and schedule a reconcile (debounced so bursts of deletions batch).
async function staleArchivePartsForPhotos(eventId: string, photoIds: string[]): Promise<void> {
  if (photoIds.length === 0) return;
  // Marks affected parts across BOTH variants' jobs STALE (the `job: { eventId }`
  // filter spans DISPLAY and ORIGINAL), then reconciles each variant so only the
  // affected parts are rebuilt — a guest who already downloaded an unaffected
  // part isn't forced to re-fetch it.
  const affected = await prisma.downloadArchivePart.updateMany({
    where: {
      job: { eventId },
      status: "READY",
      entries: { some: { photoId: { in: photoIds } } },
    },
    data: { status: "STALE" },
  });
  if (affected.count > 0) {
    await triggerReconcileAllVariants(eventId);
  }
}

export default app;
