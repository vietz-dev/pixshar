import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getS3Object } from "../lib/s3.js";
import type { HonoVariables } from "../types.js";

const app = new Hono<{ Variables: HonoVariables }>();

// GET /status now lives in the contract as `admin.backfillStatus`; the run
// itself stays a POST stream here — an EventSource cannot POST.
app.post("/start", requireAdmin, async () => {
  const photos = await prisma.photo.findMany({
    where: { status: "PROCESSED", placeholderDataUrl: null, thumbKey: { not: "" } },
    select: { id: true, thumbKey: true },
  });

  const total = photos.length;

  const stream = new ReadableStream({
    async start(controller) {
      const encode = (data: object) =>
        new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);

      controller.enqueue(encode({ total, processed: 0 }));

      const BATCH = 10;
      let processed = 0;

      for (let i = 0; i < photos.length; i += BATCH) {
        const batch = photos.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (photo) => {
            try {
              const thumbBuf = await getS3Object(photo.thumbKey);
              const placeholderDataUrl = (await new Bun.Image(thumbBuf).placeholder()) as string;
              await prisma.photo.update({
                where: { id: photo.id },
                data: { placeholderDataUrl },
              });
            } catch {
              // skip photos that fail — don't abort the whole backfill
            }
          }),
        );
        processed += batch.length;
        controller.enqueue(encode({ total, processed }));
      }

      controller.enqueue(encode({ total, processed, done: true }));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

export default app;
