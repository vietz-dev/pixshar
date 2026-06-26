import { Effect } from "effect";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { deleteS3Object } from "../lib/s3.js";
import {
  processImageEffect,
  pushPhotoStatus,
  InvalidOriginalError,
  type ProcessImageInput,
} from "./imageProcessor.js";

// ---------------------------------------------------------------------------
// Durable resize queue.
//
// The `Photo` row IS the job: status PENDING → PROCESSING → PROCESSED/FAILED,
// with attempts/nextAttemptAt/claimedAt/claimedBy driving retry + crash
// recovery. Work is claimed with Postgres `FOR UPDATE SKIP LOCKED`, so any
// number of replicas can drain the same queue without double-processing.
// ---------------------------------------------------------------------------

interface ClaimedPhoto {
  id: string;
  eventId: string;
  originalKey: string;
  fileHash: string;
  attempts: number;
}

// Atomically claim up to `limit` PENDING photos for this pod. SKIP LOCKED makes
// concurrent claimers take disjoint rows; the whole UPDATE…SELECT runs in one
// implicit transaction so the lock is held only for the claim.
async function claimBatch(podId: string, limit: number): Promise<ClaimedPhoto[]> {
  if (limit <= 0) return [];
  const now = new Date();
  const minAge = new Date(now.getTime() - env.PROCESS_MIN_AGE_MS);
  return prisma.$queryRaw<ClaimedPhoto[]>`
    UPDATE "photo" SET status = 'PROCESSING', "claimedAt" = ${now}, "claimedBy" = ${podId}
    WHERE id IN (
      SELECT id FROM "photo"
      WHERE status = 'PENDING'
        AND "originalKey" <> ''
        AND "fileHash" IS NOT NULL
        AND "createdAt" <= ${minAge}
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id, "eventId", "originalKey", "fileHash", attempts
  `;
}

async function handleFailure(photo: ClaimedPhoto, e: unknown): Promise<void> {
  const invalid = e instanceof InvalidOriginalError;
  const attempts = photo.attempts + 1;
  const exhausted = attempts >= env.PROCESS_MAX_ATTEMPTS;

  // A bad/invalid original will never become valid — drop it from S3 so the
  // dedup hash frees up via the FAILED-row recycling in initUpload.
  if (invalid) await deleteS3Object(photo.originalKey).catch(() => {});

  if (invalid || exhausted) {
    await prisma.photo.updateMany({
      where: { id: photo.id, status: "PROCESSING" },
      data: { status: "FAILED", attempts, lastError: String(e), claimedAt: null, claimedBy: null },
    });
  } else {
    const backoffMs = Math.min(60_000, 1000 * 2 ** attempts);
    await prisma.photo.updateMany({
      where: { id: photo.id, status: "PROCESSING" },
      data: {
        status: "PENDING",
        attempts,
        lastError: String(e),
        nextAttemptAt: new Date(Date.now() + backoffMs),
        claimedAt: null,
        claimedBy: null,
      },
    });
  }
  await pushPhotoStatus(photo.eventId).catch(() => {});
}

async function runOne(photo: ClaimedPhoto): Promise<void> {
  const ext = photo.originalKey.split(".").pop() || "jpg";
  const input: ProcessImageInput = {
    photoId: photo.id,
    eventId: photo.eventId,
    ext,
    originalKey: photo.originalKey,
    fileHash: photo.fileHash,
  };
  try {
    await Effect.runPromise(processImageEffect(input));
  } catch (e) {
    await handleFailure(photo, e).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Worker loop (one per process)
// ---------------------------------------------------------------------------

let inFlight = 0;
let woken = false;
let workerRunning = false;

/** Nudge the worker to claim immediately (low-latency path after an upload). */
export function wakeResizeWorker(): void {
  woken = true;
}

async function tick(podId: string): Promise<void> {
  const free = env.PROCESS_BATCH - inFlight;
  if (free <= 0) return;
  const claimed = await claimBatch(podId, free).catch(() => [] as ClaimedPhoto[]);
  for (const photo of claimed) {
    inFlight++;
    void runOne(photo).finally(() => {
      inFlight--;
      wakeResizeWorker(); // a slot freed — pull more
    });
  }
}

export function startResizeWorker(podId: string): void {
  if (workerRunning) return;
  workerRunning = true;
  console.log(`[ResizeWorker] starting (pod=${podId})`);
  setInterval(() => tick(podId).catch(() => {}), env.PROCESS_POLL_MS);
  setInterval(() => {
    if (woken) {
      woken = false;
      tick(podId).catch(() => {});
    }
  }, 100);
}

// ---------------------------------------------------------------------------
// Stale-PROCESSING reaper — recover work a crashed pod left mid-flight.
// ---------------------------------------------------------------------------

export async function reapStaleProcessing(): Promise<number> {
  const cutoff = new Date(Date.now() - env.PROCESS_LEASE_SECONDS * 1000);
  const res = await prisma.photo.updateMany({
    where: { status: "PROCESSING", claimedAt: { lt: cutoff } },
    // Don't bump attempts — a crash isn't a real processing attempt.
    data: { status: "PENDING", claimedAt: null, claimedBy: null },
  });
  if (res.count > 0) console.log(`[ResizeWorker] reaped ${res.count} stale PROCESSING photo(s)`);
  return res.count;
}

let reaperRunning = false;

export function startProcessingReaper(): void {
  if (reaperRunning) return;
  reaperRunning = true;
  reapStaleProcessing().catch(() => {}); // startup sweep
  setInterval(
    () => reapStaleProcessing().catch(() => {}),
    (env.PROCESS_LEASE_SECONDS * 1000) / 2
  );
}
