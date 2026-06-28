import PgBoss from "pg-boss";
import { env } from "./env.js";

let instance: PgBoss | null = null;

export function getBoss(): PgBoss {
  if (!instance) {
    instance = new PgBoss({
      connectionString: env.DATABASE_URL,
      monitorStateIntervalSeconds: 30,
      // Completed jobs archived after 24h, then pruned after 7d by default.
      archiveCompletedAfterSeconds: 86400,
    });
    instance.on("error", (err) => console.error("[pg-boss]", err));
  }
  return instance;
}

// All queues the application sends to must exist in pgboss.queue before
// boss.send() is called. pg-boss v10 does not auto-create queues on send —
// the insertJob SQL does an INNER JOIN with the queue table, so a missing
// entry silently returns null. boss.work() also does NOT create the queue.
export const QUEUES = {
  PHOTO_RESIZE: "photo-resize",
} as const;

export async function startBoss(): Promise<PgBoss> {
  const boss = getBoss();
  await boss.start();
  // Idempotent (ON CONFLICT DO NOTHING) — safe to call from both API and worker.
  await boss.createQueue(QUEUES.PHOTO_RESIZE);
  return boss;
}
