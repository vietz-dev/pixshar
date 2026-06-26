import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import type { HonoVariables } from "../types.js";
import { checkRateLimit, getRateLimitKey } from "../lib/rateLimit.js";
import {
  initUpload,
  completeUpload,
  uploadInitSchema,
  uploadCompleteSchema,
} from "../lib/uploadInit.js";
import { streamSSE } from "hono/streaming";
import { onPhotoStatus } from "../lib/eventBus.js";

const app = new Hono<{ Variables: HonoVariables }>();

// Step 1 — dedup the requested files and hand back presigned PUT URLs for the
// fresh ones. The browser uploads originals directly to S3 (no proxy).
app.post("/events/:id/photos/init", requireAdmin, zValidator("json", uploadInitSchema), async (c) => {
  const eventId = c.req.param("id");
  const user = c.get("user");
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Rate limit: 100 init requests per minute per admin
  const rateKey = getRateLimitKey(c, `admin-upload:${user.id}`);
  if (!checkRateLimit(rateKey, 100, 60_000)) {
    return c.json({ error: "Too many uploads. Please try again later." }, 429);
  }

  const { files } = c.req.valid("json");
  const photos = await initUpload({
    eventId: event.id,
    uploadedBy: "ADMIN",
    photographerName: null,
    files,
  });
  return c.json({ photos }, 200);
});

// Step 2 — the client confirms which uploads landed in S3; kick off processing.
app.post(
  "/events/:id/photos/complete",
  requireAdmin,
  zValidator("json", uploadCompleteSchema),
  async (c) => {
    const eventId = c.req.param("id");
    const user = c.get("user");
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      return c.json({ error: "Event not found" }, 404);
    }
    if (event.createdById !== user.id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { photoIds } = c.req.valid("json");
    await completeUpload(event.id, photoIds);
    return c.json({ ok: true }, 202);
  }
);

app.get("/events/:id/photos/status", requireAdmin, async (c) => {
  const eventId = c.req.param("id");
  const user = c.get("user");

  // Rate limit: 60 status checks per minute per event
  const rateKey = getRateLimitKey(c, `upload-status:${eventId}`);
  if (!checkRateLimit(rateKey, 60, 60_000)) {
    return c.json({ error: "Too many requests. Please try again later." }, 429);
  }

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event || event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const counts = await prisma.photo.groupBy({
    by: ["status"],
    where: { eventId },
    _count: { status: true },
  });

  const pending = counts.find((c: typeof counts[0]) => c.status === "PENDING")?._count.status ?? 0;
  const processed = counts.find((c: typeof counts[0]) => c.status === "PROCESSED")?._count.status ?? 0;
  const failed = counts.find((c: typeof counts[0]) => c.status === "FAILED")?._count.status ?? 0;

  return c.json({ pending, processed, failed, total: pending + processed + failed });
});

app.get("/events/:id/photos/status/stream", requireAdmin, async (c) => {
  const eventId = c.req.param("id");
  const user = c.get("user");

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event || event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  return streamSSE(c, async (stream) => {
    const counts = await prisma.photo.groupBy({
      by: ["status"],
      where: { eventId },
      _count: { status: true },
    });
    const pending = counts.find((r: typeof counts[0]) => r.status === "PENDING")?._count.status ?? 0;
    const processed = counts.find((r: typeof counts[0]) => r.status === "PROCESSED")?._count.status ?? 0;
    const failed = counts.find((r: typeof counts[0]) => r.status === "FAILED")?._count.status ?? 0;

    await stream.writeSSE({
      data: JSON.stringify({ pending, processed, failed, total: pending + processed + failed }),
      event: "photo-status",
    });

    const unsubscribe = onPhotoStatus(eventId, async (payload) => {
      await stream.writeSSE({ data: JSON.stringify(payload), event: "photo-status" });
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

export default app;
