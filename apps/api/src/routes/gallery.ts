import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import { requireGallerySession } from "../middleware/requireGallerySession.js";
import type { HonoVariables } from "../types.js";
import { checkRateLimit, getRateLimitKey } from "../lib/rateLimit.js";
import {
  initUpload,
  completeUpload,
  uploadInitSchema,
  uploadCompleteSchema,
} from "../lib/uploadInit.js";
import { streamSSE } from "hono/streaming";
import { onDownloadStatus, onPhotoProcessed } from "../lib/eventBus.js";
import { buildBothVariantsPayload } from "../services/downloadJob.js";
import { archiveDownloadsTotal } from "../lib/metrics.js";

const app = new Hono<{ Variables: HonoVariables }>();

// NOTE: the public info endpoint, POST /:slug/unlock, GET /:slug and the
// per-photo download now live in the contract as `gallery.{info,unlock,get,
// photoDownload}` (apps/api/src/rpc/router.ts). What remains here is the two
// SSE streams and the upload/archive endpoints.

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
  },
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
  },
);

app.get("/:slug/download", requireGallerySession, async (c) => {
  // Rate limit: 30 download checks per minute per gallery
  const rateKey = getRateLimitKey(c, `download-check:${c.req.param("slug")}`);
  if (!checkRateLimit(rateKey, 30, 60_000)) {
    return c.json({ error: "Too many requests. Please try again later." }, 429);
  }

  const event = await prisma.event.findUnique({
    where: { slug: c.req.param("slug") },
  });

  if (!event) {
    return c.json({ error: "Gallery not found" }, 404);
  }

  // Both-variants payload: Kompakt (default) + Original in one round trip, each
  // serving whatever parts are already built (partial availability). Lazily
  // creates the Kompakt job for events that predate the variant.
  const payload = await buildBothVariantsPayload(event.id, event.slug);
  if (payload.status === "READY") archiveDownloadsTotal.inc();

  return c.json(payload);
});

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
