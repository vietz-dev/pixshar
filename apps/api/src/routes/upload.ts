import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { processImage } from "../services/imageProcessor.js";
import { Effect } from "effect";
import type { HonoVariables } from "../types.js";
import { checkRateLimit, getRateLimitKey } from "../lib/rateLimit.js";
import { validateFiles, validateFileMagicBytes } from "../lib/validate.js";

const app = new Hono<{ Variables: HonoVariables }>();

app.post("/events/:id/photos", requireAdmin, async (c) => {
  const eventId = c.req.param("id");
  const user = c.get("user");
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  if (event.createdById !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const form = await c.req.formData();
  const files = form.getAll("files") as File[];

  if (!files.length) {
    return c.json({ error: "No files provided" }, 400);
  }

  // Rate limit: 100 uploads per minute per admin
  const userId = c.get("user").id;
  const rateKey = getRateLimitKey(c, `admin-upload:${userId}`);
  if (!checkRateLimit(rateKey, 100, 60_000)) {
    return c.json({ error: "Too many uploads. Please try again later." }, 429);
  }

  const validation = validateFiles(files);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  // Verify actual file content (magic bytes) — prevents MIME type spoofing
  for (const file of files) {
    const magic = await validateFileMagicBytes(file);
    if (!magic.valid) {
      return c.json({ error: magic.error }, 400);
    }
  }

  const results = await Promise.all(
    files.map(async (file) => {
      const buffer = Buffer.from(await file.arrayBuffer());
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const cleanExt = ext === "png" ? "png" : "jpg";

      const photo = await prisma.photo.create({
        data: {
          eventId: event.id,
          photographerName: null,
          originalKey: "",
          displayKey: "",
          thumbKey: "",
          status: "PENDING",
          uploadedBy: "ADMIN",
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

export default app;
