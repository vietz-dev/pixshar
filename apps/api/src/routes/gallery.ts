import { Hono } from "hono";
import { requireGallerySession } from "../middleware/requireGallerySession.js";
import type { HonoVariables } from "../types.js";
import { streamSSE } from "hono/streaming";
import { onDownloadStatus, onPhotoProcessed } from "../lib/eventBus.js";
import { buildBothVariantsPayload } from "../services/downloadJob.js";
import { archiveDownloadsTotal } from "../lib/metrics.js";

const app = new Hono<{ Variables: HonoVariables }>();

// NOTE: the public info endpoint, POST /:slug/unlock, GET /:slug and the
// per-photo download now live in the contract as `gallery.{info,unlock,get,
// photoDownload}`, the archive payload as `gallery.download` and the upload
// bookends as `gallery.upload.{init,complete}` (apps/api/src/rpc/router.ts).
// What remains here is the three SSE streams.

app.get("/:slug/download/stream", requireGallerySession, async (c) => {
  const event = c.get("galleryEvent");

  return streamSSE(c, async (stream) => {
    // Always emit the full both-variants payload (fresh presigned URLs) so the
    // guest page can render already-built parts of each variant + a
    // per-variant "still building" banner. Any variant's status change
    // re-emits the whole payload so both tabs stay live.
    const initial = await buildBothVariantsPayload(event.id, event.slug);
    if (initial.status === "READY") archiveDownloadsTotal.inc();
    await stream.writeSSE({ data: JSON.stringify(initial), event: "download-status" });

    const unsubscribe = onDownloadStatus(event.id, async () => {
      const payload = await buildBothVariantsPayload(event.id, event.slug);
      if (payload.status === "READY") archiveDownloadsTotal.inc();
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

// Live feed of newly-processed photos so the guest grid fills in without a refresh.
app.get("/:slug/photos/stream", requireGallerySession, async (c) => {
  const event = c.get("galleryEvent");

  return streamSSE(c, async (stream) => {
    const unsubscribe = onPhotoProcessed(event.id, async (payload) => {
      await stream.writeSSE({ data: JSON.stringify(payload), event: "photo-new" });
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

export default app;
