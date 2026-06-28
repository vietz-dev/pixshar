import { env } from "./lib/env.js";
import { initDatabase } from "./lib/prisma.js";
import { startBoss } from "./lib/pgboss.js";
import { photoResizeHandler } from "./jobs/photoResize.js";
import { startDebouncePoller, startZipReaper } from "./services/downloadJob.js";
import { register } from "prom-client";
import { resizeQueueInflight } from "./lib/metrics.js";

if (import.meta.main) {
  console.log("[Worker] starting image-processor");

  await initDatabase();

  const boss = await startBoss();
  console.log("[Worker] pg-boss started");

  await boss.work<{ photoId: string }>(
    "photo-resize",
    { batchSize: env.WORKER_CONCURRENCY },
    async (jobs) => {
      const batch = Array.isArray(jobs) ? jobs : [jobs];
      resizeQueueInflight.inc(batch.length);
      try {
        await Promise.all(batch.map((job) => photoResizeHandler(job)));
      } finally {
        resizeQueueInflight.dec(batch.length);
      }
    }
  );

  // Archive build remains DB-polling based; poller now runs here instead of API.
  startDebouncePoller();
  startZipReaper();

  Bun.serve({
    port: env.WORKER_METRICS_PORT,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      if (pathname === "/metrics") {
        const body = await register.metrics();
        return new Response(body, {
          headers: { "Content-Type": register.contentType },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`[Worker] metrics on :${env.WORKER_METRICS_PORT}/metrics`);
  console.log(`[Worker] concurrency=${env.WORKER_CONCURRENCY}`);

  process.on("SIGTERM", async () => {
    console.log("[Worker] SIGTERM — stopping pg-boss");
    await boss.stop({ graceful: true });
    process.exit(0);
  });
}
