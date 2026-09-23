import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import type { HonoVariables } from "../types.js";
import { streamSSE } from "hono/streaming";
import { onPhotoStatus, onPhotoProcessed } from "../lib/eventBus.js";

const app = new Hono<{ Variables: HonoVariables }>();

// NOTE: init / complete / status now live in the contract as `upload.{init,
// complete,status}` (apps/api/src/rpc/router.ts). Only the SSE stream remains —
// EventSource cannot carry an RPC call.

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
    const pending =
      counts.find((r: (typeof counts)[0]) => r.status === "PENDING")?._count.status ?? 0;
    const processed =
      counts.find((r: (typeof counts)[0]) => r.status === "PROCESSED")?._count.status ?? 0;
    const failed =
      counts.find((r: (typeof counts)[0]) => r.status === "FAILED")?._count.status ?? 0;

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

    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: "ping", event: "keep-alive" }).catch(() => {});
    }, 15_000);

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        unsubStatus();
        unsubPhoto();
        clearInterval(keepAlive);
        resolve();
      });
    });
  });
});

export default app;
