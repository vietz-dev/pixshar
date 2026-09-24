import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { onDownloadStatus, onPhotoProcessed, onPhotoStatus } from "../lib/eventBus.js";
import { archiveDownloadsTotal } from "../lib/metrics.js";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireGallerySession } from "../middleware/requireGallerySession.js";
import { buildBothVariantsPayload, statusMessage } from "../services/downloadJob.js";
import type { HonoVariables } from "../types.js";
import type { DownloadStatus, Quality } from "@pixshar/contracts";

/**
 * Every SSE endpoint of the API. They stay plain Hono routes on purpose: an
 * `EventSource` cannot speak RPC, and keeping them here preserves the browser's
 * native reconnect, the 120 s `Bun.serve` idle timeout and the metrics
 * middleware's `/stream` skip. Only their payload *types* come from the
 * contract.
 */
const app = new Hono<{ Variables: HonoVariables }>();

const KEEP_ALIVE_MS = 15_000;

/**
 * Pings every 15 s and keeps the handler alive until the client disconnects.
 * `subscribe` returns the unsubscribe function for the bus listener.
 */
async function holdOpen(stream: SSEStreamingApi, unsubscribe: () => void): Promise<void> {
  const keepAlive = setInterval(() => {
    stream.writeSSE({ data: "ping", event: "keep-alive" }).catch(() => {});
  }, KEEP_ALIVE_MS);

  await new Promise<void>((resolve) => {
    stream.onAbort(() => {
      unsubscribe();
      clearInterval(keepAlive);
      resolve();
    });
  });
}

// Admin archive build status, one variant per stream (?quality=, default ORIGINAL).
app.get("/events/:id/download/status/stream", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) return c.json({ error: "Event not found" }, 404);
  if (event.createdById !== user.id) return c.json({ error: "Forbidden" }, 403);

  const quality: Quality = c.req.query("quality") === "DISPLAY" ? "DISPLAY" : "ORIGINAL";

  return streamSSE(c, async (stream) => {
    const job = await prisma.downloadJob.findUnique({
      where: { eventId_quality: { eventId: id, quality } },
    });
    const totalPhotos = await prisma.photo.count({ where: { eventId: id, status: "PROCESSED" } });

    const initial: DownloadStatus = job
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
      : {
          quality,
          status: "NONE",
          message: statusMessage("NONE"),
          photoCount: 0,
          processedPhotos: 0,
          uploadProgress: 0,
          totalPhotos,
          totalSizeBytes: null,
          partCount: 0,
          debounceUntil: null,
          failureReason: null,
          updatedAt: new Date().toISOString(),
        };

    await stream.writeSSE({ data: JSON.stringify(initial), event: "download-status" });

    // Both variants share one per-event bus key; forward only this stream's
    // variant so each admin panel gets an independent feed.
    const unsubscribe = onDownloadStatus(id, async (payload) => {
      if (payload.quality !== quality) return;
      await stream.writeSSE({ data: JSON.stringify(payload), event: "download-status" });
    });

    await holdOpen(stream, unsubscribe);
  });
});

// Admin processing counters + newly-processed photos for one event.
app.get("/upload/events/:id/photos/status/stream", requireAdmin, async (c) => {
  const eventId = c.req.param("id");
  const user = c.get("user");

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event || event.createdById !== user.id) return c.json({ error: "Forbidden" }, 403);

  return streamSSE(c, async (stream) => {
    const counts = await prisma.photo.groupBy({
      by: ["status"],
      where: { eventId },
      _count: { status: true },
    });
    const of = (status: string) =>
      counts.find((r: (typeof counts)[number]) => r.status === status)?._count.status ?? 0;
    const [pending, processed, failed] = [of("PENDING"), of("PROCESSED"), of("FAILED")];

    await stream.writeSSE({
      data: JSON.stringify({ pending, processed, failed, total: pending + processed + failed }),
      event: "photo-status",
    });

    const unsubStatus = onPhotoStatus(eventId, async (payload) => {
      await stream.writeSSE({ data: JSON.stringify(payload), event: "photo-status" });
    });
    const unsubPhoto = onPhotoProcessed(eventId, async (payload) => {
      await stream.writeSSE({ data: JSON.stringify(payload), event: "photo-new" });
    });

    await holdOpen(stream, () => {
      unsubStatus();
      unsubPhoto();
    });
  });
});

// Guest archive status. Always emits the full both-variants payload (fresh
// presigned URLs) so the download page can show already-built parts of each
// variant plus a per-variant "still building" banner.
app.get("/gallery/:slug/download/stream", requireGallerySession, async (c) => {
  const event = c.get("galleryEvent");

  return streamSSE(c, async (stream) => {
    const emit = async () => {
      const payload = await buildBothVariantsPayload(event.id, event.slug);
      if (payload.status === "READY") archiveDownloadsTotal.inc();
      await stream.writeSSE({ data: JSON.stringify(payload), event: "download-status" });
    };

    await emit();
    await holdOpen(stream, onDownloadStatus(event.id, emit));
  });
});

// Live feed of newly-processed photos so the guest grid fills in without a refresh.
app.get("/gallery/:slug/photos/stream", requireGallerySession, async (c) => {
  const event = c.get("galleryEvent");

  return streamSSE(c, async (stream) => {
    const unsubscribe = onPhotoProcessed(event.id, async (payload) => {
      await stream.writeSSE({ data: JSON.stringify(payload), event: "photo-new" });
    });

    await holdOpen(stream, unsubscribe);
  });
});

export default app;
