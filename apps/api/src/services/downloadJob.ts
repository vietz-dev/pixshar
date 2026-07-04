import { Effect, Schedule, Console } from "effect";
import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { s3, s3Keys, deleteS3Object, listS3Prefix, getPresignedUrl } from "../lib/s3.js";
import { env } from "../lib/env.js";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { Photo } from "@prisma/client";
import { emitDownloadStatus, PG_NOTIFY_CHANNEL } from "../lib/eventBus.js";
import { planArchiveParts, zipEntryBytes, type PlannedEntry } from "./archivePlanner.js";

export function statusMessage(status: string): string {
  switch (status) {
    case "NONE": return "No archive created yet.";
    case "DEBOUNCING": return "Waiting for uploads to settle.";
    case "QUEUED": return "Queued for building.";
    case "BUILDING": return "Building archive…";
    case "READY": return "Archive ready for download.";
    case "FAILED": return "Archive build failed.";
    case "CANCELLED": return "Archive build was cancelled.";
    default: return "Unknown status.";
  }
}

export async function pushDownloadStatus(eventId: string): Promise<void> {
  const [job, totalPhotos] = await Promise.all([
    prisma.downloadJob.findUnique({ where: { eventId } }),
    prisma.photo.count({ where: { eventId, status: "PROCESSED" } }),
  ]);
  if (!job) return;
  emitDownloadStatus(eventId, {
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
  });
}

// Emit locally (covers listeners in this process) AND via pg_notify so the API
// process's SSE streams fire when this code runs inside the worker container.
// The pg_notify listener re-reads the row and emits locally — it must call
// pushDownloadStatus, never this function, or the two processes would ping-pong.
export async function notifyDownloadStatus(eventId: string): Promise<void> {
  pushDownloadStatus(eventId).catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `SELECT pg_notify($1, $2)`,
      PG_NOTIFY_CHANNEL,
      JSON.stringify({ type: "download.status", eventId })
    )
    .catch(() => {});
}

function membershipSig(photoIds: string[]): string {
  // Stable content identity of a part: sha1 over its sorted photoId list. Changes
  // only when the part's photo set changes (a deletion) — never on a pure rebuild.
  return createHash("sha1").update([...photoIds].sort().join(",")).digest("hex");
}

// ---------------------------------------------------------------------------
// 1. Debounce trigger — called after every successful photo processing
// ---------------------------------------------------------------------------

export async function triggerDebounce(eventId: string): Promise<void> {
  const now = Date.now();
  const debounceUntil = new Date(now + env.DOWNLOAD_DEBOUNCE_SECONDS * 1000);
  const debounceStartedAt = new Date(now);
  console.log(`[Debounce] event=${eventId} debounceUntil=${debounceUntil.toISOString()}`);

  await prisma.$transaction(async (tx) => {
    // Increment processed photo count
    await tx.event.update({
      where: { id: eventId },
      data: { processedPhotoCount: { increment: 1 } },
    });

    // Upsert DownloadJob with state-machine transitions. `debounceStartedAt` is
    // set only when *entering* DEBOUNCING (never on extend) so checkDebounceTimers
    // can enforce a max-wait ceiling and the zip still builds during bulk uploads.
    const existing = await tx.downloadJob.findUnique({
      where: { eventId },
    });

    if (!existing) {
      await tx.downloadJob.create({
        data: { eventId, status: "DEBOUNCING", debounceUntil, debounceStartedAt },
      });
      console.log(`[Debounce] event=${eventId} created new DEBOUNCING job`);
      return;
    }

    switch (existing.status) {
      case "DEBOUNCING": {
        // Extend the quiet timer but keep the original debounceStartedAt.
        await tx.downloadJob.update({
          where: { id: existing.id },
          data: { debounceUntil, processedPhotos: 0 },
        });
        console.log(`[Debounce] event=${eventId} reset DEBOUNCING timer`);
        break;
      }
      case "QUEUED": {
        await tx.downloadJob.update({
          where: { id: existing.id },
          data: { status: "DEBOUNCING", debounceUntil, debounceStartedAt, queuedAt: null, processedPhotos: 0 },
        });
        console.log(`[Debounce] event=${eventId} QUEUED -> DEBOUNCING`);
        break;
      }
      case "BUILDING": {
        // Do NOT interrupt active build
        console.log(`[Debounce] event=${eventId} BUILDING in progress, skipping`);
        break;
      }
      case "READY": {
        // Incremental model: existing parts are immutable and stay downloadable.
        // We only re-enter DEBOUNCING to schedule a reconcile that appends the
        // newly-arrived photos as NEW parts — never wipe what's already built.
        await tx.downloadJob.update({
          where: { id: existing.id },
          data: { status: "DEBOUNCING", debounceUntil, debounceStartedAt, processedPhotos: 0 },
        });
        console.log(`[Debounce] event=${eventId} READY -> DEBOUNCING (append pending)`);
        break;
      }
      case "FAILED":
      case "CANCELLED": {
        await tx.downloadJob.update({
          where: { id: existing.id },
          data: { status: "DEBOUNCING", debounceUntil, debounceStartedAt, failureReason: null, processedPhotos: 0 },
        });
        console.log(`[Debounce] event=${eventId} ${existing.status} -> DEBOUNCING`);
        break;
      }
    }
  });

  notifyDownloadStatus(eventId).catch(() => {});
}

// ---------------------------------------------------------------------------
// 1b. Reconcile trigger — schedule a build after a deletion or an admin action
// ---------------------------------------------------------------------------

// Unlike triggerDebounce this does NOT bump the processed-photo counter; it just
// schedules a (re)build. `immediate` skips the quiet window (admin "build now" /
// "rebuild all"); otherwise it debounces so bursts of deletions batch.
// Always routes through QUEUED/DEBOUNCING → the FIFO build queue, never a direct
// synchronous build, so worker/image-processor load stays bounded.
export async function triggerReconcile(
  eventId: string,
  opts: { immediate?: boolean } = {}
): Promise<void> {
  const now = Date.now();
  const job = await prisma.downloadJob.findUnique({ where: { eventId } });
  if (!job) return; // no archive/job for this event — nothing to reconcile

  if (job.status === "BUILDING") {
    // Don't disturb the in-flight build. Any parts marked STALE by the caller are
    // picked up by the post-build re-queue check (see buildZip).
    console.log(`[Reconcile] event=${eventId} BUILDING in progress, will re-queue after`);
    notifyDownloadStatus(eventId).catch(() => {});
    return;
  }

  if (opts.immediate) {
    await prisma.downloadJob.updateMany({
      where: { eventId, status: { not: "BUILDING" } },
      data: { status: "QUEUED", queuedAt: new Date(now), debounceUntil: null, failureReason: null, processedPhotos: 0 },
    });
    console.log(`[Reconcile] event=${eventId} queued immediately (was ${job.status})`);
  } else {
    await prisma.downloadJob.updateMany({
      where: { eventId, status: { not: "BUILDING" } },
      data: {
        status: "DEBOUNCING",
        debounceUntil: new Date(now + env.DOWNLOAD_DEBOUNCE_SECONDS * 1000),
        debounceStartedAt: new Date(now),
        queuedAt: null,
        failureReason: null,
        processedPhotos: 0,
      },
    });
    console.log(`[Reconcile] event=${eventId} debouncing (was ${job.status})`);
  }
  notifyDownloadStatus(eventId).catch(() => {});
}

// ---------------------------------------------------------------------------
// 2. Debounce poller — background loop
// ---------------------------------------------------------------------------

let pollerRunning = false;

export function startDebouncePoller(): void {
  if (pollerRunning) return;
  pollerRunning = true;
  console.log(`[Poller] starting (interval=15s)`);
  setInterval(() => {
    checkDebounceTimers().catch(() => {});
  }, 15_000);
}

async function checkDebounceTimers(): Promise<void> {
  const now = new Date();
  const maxWaitCutoff = new Date(now.getTime() - env.DOWNLOAD_MAX_WAIT_SECONDS * 1000);

  // Build when quiet period elapsed OR max-wait ceiling hit (so a
  // continuous stream of uploads can't starve the archive indefinitely).
  const ready = await prisma.downloadJob.findMany({
    where: {
      status: "DEBOUNCING",
      OR: [
        { debounceUntil: { lte: now } },
        { debounceStartedAt: { lte: maxWaitCutoff } },
      ],
    },
    orderBy: { debounceStartedAt: "asc" },
  });

  for (const job of ready) {
    // Count-checked transition so two replicas can't both launch the build.
    const res = await prisma.downloadJob.updateMany({
      where: { id: job.id, status: "DEBOUNCING" },
      data: { status: "QUEUED", queuedAt: new Date(), processedPhotos: 0 },
    });
    if (res.count !== 1) continue;
    console.log(`[Poller] queuing build for event=${job.eventId}`);
    notifyDownloadStatus(job.eventId).catch(() => {});
  }

  // Enqueue all QUEUED jobs (incl. build-now / rebuild-all ones, which bypass DEBOUNCING)
  // into the per-process serial build queue, oldest first. runBuildZip
  // atomically claims QUEUED→BUILDING so concurrent worker replicas stay safe.
  const queued = await prisma.downloadJob.findMany({
    where: { status: "QUEUED" },
    orderBy: [{ queuedAt: "asc" }, { createdAt: "asc" }],
  });
  for (const job of queued) {
    runBuildZip(job.eventId);
  }
}

// ---------------------------------------------------------------------------
// 2b. Stale-BUILDING reaper — recover a build a crashed pod left mid-flight.
// ---------------------------------------------------------------------------

export async function reapStaleBuilding(): Promise<number> {
  const cutoff = new Date(Date.now() - env.DOWNLOAD_BUILD_LEASE_SECONDS * 1000);
  // queuedAt is intentionally left untouched: a crashed build keeps its place
  // at the front of the FIFO queue.
  const res = await prisma.downloadJob.updateMany({
    where: {
      status: "BUILDING",
      OR: [
        { heartbeatAt: { lt: cutoff } },
        { heartbeatAt: null, updatedAt: { lt: cutoff } }, // legacy/never-heartbeated rows
      ],
    },
    data: { status: "QUEUED", processedPhotos: 0 },
  });
  if (res.count > 0) console.log(`[ZipReaper] requeued ${res.count} stale BUILDING job(s)`);
  return res.count;
}

let zipReaperRunning = false;

export function startZipReaper(): void {
  if (zipReaperRunning) return;
  zipReaperRunning = true;
  reapStaleBuilding().catch(() => {}); // startup sweep
  setInterval(
    () => reapStaleBuilding().catch(() => {}),
    (env.DOWNLOAD_BUILD_LEASE_SECONDS * 1000) / 2
  );
}

// ---------------------------------------------------------------------------
// 3. Manual controls (admin)
// ---------------------------------------------------------------------------

// Admin "build now": skip the quiet debounce window and queue the pending
// reconcile immediately. Only the *timer* is skipped — the build still goes
// through QUEUED → FIFO claim, so it never bypasses the worker/image-processor
// load management. If nothing is pending (already READY with no new photos), it
// is a no-op.
export async function buildNow(eventId: string): Promise<void> {
  const job = await prisma.downloadJob.findUnique({ where: { eventId } });
  if (!job) return; // no job → no pending uploads to build

  if (job.status === "DEBOUNCING" || job.status === "FAILED" || job.status === "CANCELLED") {
    await prisma.downloadJob.updateMany({
      where: { eventId, status: job.status },
      data: { status: "QUEUED", queuedAt: new Date(), debounceUntil: null, failureReason: null, processedPhotos: 0 },
    });
    console.log(`[BuildNow] event=${eventId} ${job.status} -> QUEUED`);
    notifyDownloadStatus(eventId).catch(() => {});
  } else {
    // QUEUED / BUILDING / READY: already queued or nothing new to build.
    console.log(`[BuildNow] event=${eventId} no-op (status=${job.status})`);
  }
}

// Admin "rebuild all": regenerate every existing part's ZIP bytes. Marks all
// parts STALE so the reconcile rebuilds each one FROM ITS STORED MEMBERSHIP
// (never re-planning across parts), then queues immediately. Membership is
// preserved, so a guest who already downloaded a part is not forced to
// re-download it unless a photo was deleted from that exact part.
export async function rebuildAll(eventId: string): Promise<void> {
  const job = await prisma.downloadJob.findUnique({ where: { eventId } });
  if (!job) return;

  await prisma.downloadArchivePart.updateMany({
    where: { jobId: job.id },
    data: { status: "STALE" },
  });
  console.log(`[RebuildAll] event=${eventId} marked all parts STALE`);
  await triggerReconcile(eventId, { immediate: true });
}

// Cancel an in-flight/pending build. Incremental model: already-committed parts
// are immutable and stay downloadable, so cancel does NOT delete the archive —
// it just stops adding new/updated parts. A STALE part reverts to READY (its old
// object is still valid) so it isn't stuck showing "updating".
export async function cancelJob(eventId: string): Promise<void> {
  const job = await prisma.downloadJob.findUnique({ where: { eventId } });
  if (!job) return;

  if (job.status !== "BUILDING" && job.status !== "QUEUED" && job.status !== "DEBOUNCING") {
    return; // nothing to cancel
  }

  await prisma.downloadJob.update({
    where: { id: job.id },
    data: { status: "CANCELLED", processedPhotos: 0, failureReason: "Cancelled by admin" },
  });
  // Revert any pending rebuilds — the old (still-present) object stays served.
  await prisma.downloadArchivePart.updateMany({
    where: { jobId: job.id, status: "STALE" },
    data: { status: "READY" },
  });
  notifyDownloadStatus(eventId).catch(() => {});
}

export interface DownloadPart {
  index: number;
  url: string | null; // null when no downloadable object exists yet
  sizeBytes: number;
  photoCount: number;
  membershipSig: string; // client keys its "downloaded" tick on this
  rebuilding: boolean; // STALE: a newer version is being built; url serves the old one
}

export interface DownloadPayload {
  status: "READY" | "BUILDING" | "DEBOUNCING" | "FAILED" | "NONE";
  parts: DownloadPart[];
  partCount: number;
  totalSizeBytes: number;
  photoCount: number;
  building: boolean; // more content pending (job active or a part being rebuilt)
  message: string;
  debounceUntil?: string | null;
  processedPhotos?: number;
  uploadProgress?: number;
}

// Part-aware download payload. Existing parts are served regardless of the job's
// state (partial availability): a guest can always grab the parts already built,
// even while newer photos are being appended or a part is being rebuilt.
export async function buildDownloadPayload(
  eventId: string,
  slug: string,
  expiresIn = 60 * 60
): Promise<DownloadPayload> {
  const job = await prisma.downloadJob.findUnique({
    where: { eventId },
    include: { parts: { orderBy: { partIndex: "asc" } } },
  });

  if (!job) {
    return { status: "NONE", parts: [], partCount: 0, totalSizeBytes: 0, photoCount: 0, building: false, message: statusMessage("NONE") };
  }

  const jobActive = job.status === "DEBOUNCING" || job.status === "QUEUED" || job.status === "BUILDING";
  const anyStale = job.parts.some((p) => p.status === "STALE");
  const building = jobActive || anyStale;

  // Only parts with a committed S3 object are offered for download.
  const downloadable = job.parts.filter((p) => p.key);
  const n = downloadable.length;

  if (n === 0) {
    const status: DownloadPayload["status"] =
      job.status === "FAILED" || job.status === "CANCELLED" ? "FAILED"
      : job.status === "DEBOUNCING" ? "DEBOUNCING"
      : job.status === "QUEUED" || job.status === "BUILDING" ? "BUILDING"
      : "NONE";
    return {
      status,
      parts: [],
      partCount: 0,
      totalSizeBytes: 0,
      photoCount: job.photoCount,
      building,
      message: statusMessage(status === "FAILED" ? "FAILED" : status === "DEBOUNCING" ? "DEBOUNCING" : status === "BUILDING" ? "BUILDING" : "NONE"),
      debounceUntil: job.debounceUntil?.toISOString() ?? null,
      processedPhotos: job.processedPhotos,
      uploadProgress: job.uploadProgress,
    };
  }

  const parts: DownloadPart[] = await Promise.all(
    downloadable.map(async (p) => ({
      index: p.partIndex,
      sizeBytes: Number(p.sizeBytes),
      photoCount: p.photoCount,
      membershipSig: p.membershipSig,
      rebuilding: p.status === "STALE",
      url: await getPresignedUrl(
        p.key,
        "get",
        expiresIn,
        n === 1
          ? `attachment; filename="${slug}.zip"`
          : `attachment; filename="${slug}-part-${p.partIndex}-of-${n}.zip"`
      ),
    }))
  );

  return {
    status: "READY",
    parts,
    partCount: n,
    totalSizeBytes: parts.reduce((sum, p) => sum + p.sizeBytes, 0),
    photoCount: job.parts.reduce((sum, p) => sum + p.photoCount, 0),
    building,
    message: building ? "Some parts are still being prepared." : statusMessage("READY"),
    debounceUntil: job.debounceUntil?.toISOString() ?? null,
    processedPhotos: job.processedPhotos,
    uploadProgress: job.uploadProgress,
  };
}

export async function getDownloadJobStatus(eventId: string) {
  const job = await prisma.downloadJob.findUnique({
    where: { eventId },
    include: { parts: { orderBy: { partIndex: "asc" } } },
  });
  if (!job) return null;

  return {
    id: job.id,
    status: job.status,
    photoCount: job.photoCount,
    processedPhotos: job.processedPhotos,
    uploadProgress: job.uploadProgress,
    totalSizeBytes: job.totalSizeBytes === null ? null : Number(job.totalSizeBytes),
    partCount: job.partCount,
    parts: job.parts.map((p) => ({
      partIndex: p.partIndex,
      key: p.key,
      sizeBytes: Number(p.sizeBytes),
      status: p.status,
      photoCount: p.photoCount,
      membershipSig: p.membershipSig,
      generation: p.generation,
    })),
    debounceUntil: job.debounceUntil,
    failureReason: job.failureReason,
    updatedAt: job.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// 4. ZIP build pipeline — serialized per process
// ---------------------------------------------------------------------------

// Exactly one archive build runs at a time in this process, FIFO. A single
// image-processor container must keep resizing photos while it builds one
// archive; concurrent builds would multiply peak memory and I/O. Multiple
// worker replicas can still build *different* events in parallel because
// claimJob's QUEUED→BUILDING CAS hands each event to exactly one replica.
const enqueuedBuilds = new Set<string>();
let buildChain: Promise<void> = Promise.resolve();

export function runBuildZip(eventId: string): void {
  if (enqueuedBuilds.has(eventId)) return;
  enqueuedBuilds.add(eventId);
  console.log(`[BuildZip] enqueued event=${eventId} (queue depth=${enqueuedBuilds.size})`);
  buildChain = buildChain.then(async () => {
    try {
      await Effect.runPromise(buildZip(eventId));
    } catch (e) {
      console.error(`[BuildZip] event=${eventId} unexpected failure: ${e}`);
    } finally {
      enqueuedBuilds.delete(eventId);
    }
  });
}

const buildZip = (eventId: string) =>
  Effect.gen(function* () {
    const job = yield* claimJob(eventId);
    if (!job) {
      console.log(`[BuildZip] event=${eventId} claim failed, aborting`);
      return;
    }
    console.log(`[BuildZip] event=${eventId} claimed job ${job.id}`);
    yield* Effect.promise(() => notifyDownloadStatus(eventId).catch(() => {}));

    const photos = yield* loadPhotos(eventId);
    console.log(`[BuildZip] event=${eventId} loaded ${photos.length} photos`);
    yield* markBuilding(job.id, photos.length);
    yield* Effect.promise(() => notifyDownloadStatus(eventId).catch(() => {}));

    // Retry only the S3 streaming part — claimJob must NOT be retried
    // because it atomically transitions QUEUED→BUILDING and a second
    // attempt would see BUILDING and return null (broken retry).
    // Each attempt restarts from scratch: streamZipPartsToS3 deletes any
    // parts left by the previous attempt before writing.
    const result = yield* streamZipPartsToS3(eventId, photos, job.id).pipe(
      // Catch CANCELLED/SUPERSEDED before retry — do NOT retry those.
      Effect.catchAll((e) => {
        if (e.message === "CANCELLED" || e.message === "SUPERSEDED") {
          // Incremental model: committed parts are immutable and valid — leave
          // them. The in-flight object was aborted; unassigned photos and any
          // STALE parts are simply handled by the next reconcile.
          console.log(`[BuildZip] event=${eventId} ${e.message} mid-build, leaving committed parts`);
          return Effect.succeed(undefined);
        }
        return Effect.fail(e);
      }),
      Effect.retry({
        times: 3,
        schedule: Schedule.exponential("1 second"),
      })
    );

    if (!result) {
      console.log(`[BuildZip] event=${eventId} cancelled/superseded, skipping markReady`);
      return;
    }

    const readyCount = yield* markReady(job.id, result.partCount, result.totalSizeBytes);
    if (readyCount === 0) {
      // Superseded (row no longer BUILDING) — drop this result.
      console.log(`[BuildZip] event=${eventId} markReady no-op (superseded), skipping push`);
      return;
    }
    console.log(
      `[BuildZip] event=${eventId} marked READY (parts=${result.partCount}, totalSize=${result.totalSizeBytes})`
    );
    yield* Effect.promise(() => notifyDownloadStatus(eventId).catch(() => {}));

    // If more STALE parts appeared during this build (e.g. rebuildAll or a
    // deletion arrived mid-build), run another pass so they don't get stuck.
    yield* Effect.promise(async () => {
      const remainingStale = await prisma.downloadArchivePart.count({
        where: { jobId: job.id, status: "STALE" },
      });
      if (remainingStale > 0) {
        await prisma.downloadJob.updateMany({
          where: { eventId, status: "READY" },
          data: { status: "QUEUED", queuedAt: new Date(), processedPhotos: 0 },
        });
        console.log(`[BuildZip] event=${eventId} ${remainingStale} STALE part(s) remain, re-queued`);
        await notifyDownloadStatus(eventId).catch(() => {});
      }
    });
  }).pipe(
    Effect.catchAll((e) =>
      Effect.gen(function* () {
        yield* Console.error(`ZIP build failed for event ${eventId}: ${e}`);
        const job = yield* Effect.tryPromise({
          try: () => prisma.downloadJob.findUnique({ where: { eventId } }),
          catch: () => null,
        });
        if (job && job.status !== "CANCELLED") {
          yield* markFailed(job.id, String(e));
          yield* Effect.promise(() => notifyDownloadStatus(eventId).catch(() => {}));
        }
      })
    )
  );

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

const claimJob = (eventId: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await prisma.downloadJob.update({
          where: { eventId, status: "QUEUED" },
          data: { status: "BUILDING", processedPhotos: 0, heartbeatAt: new Date() },
        });
      } catch {
        return null;
      }
    },
    catch: (e) => new Error(`Claim job failed: ${e}`),
  });

const loadPhotos = (eventId: string) =>
  Effect.tryPromise({
    try: () =>
      prisma.photo.findMany({
        where: { eventId, status: "PROCESSED" },
        orderBy: { createdAt: "asc" },
      }),
    catch: (e) => new Error(`Load photos failed: ${e}`),
  });

// All BUILDING-phase writes are guarded `where {id, status:"BUILDING"}` so a
// concurrent build-now/rebuild-all (which resets the row to QUEUED) makes a stale fiber's
// writes no-ops instead of clobbering the new build. They also refresh the
// heartbeat lease used by reapStaleBuilding.
const markBuilding = (jobId: string, photoCount: number) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.updateMany({
        where: { id: jobId, status: "BUILDING" },
        data: { photoCount, processedPhotos: 0, heartbeatAt: new Date() },
      }),
    catch: (e) => new Error(`Mark building failed: ${e}`),
  });

// Returns the update count so the caller can skip the READY push on a no-op
// (the build was superseded by a re-queue).
const markReady = (jobId: string, partCount: number, totalSizeBytes: number) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.updateMany({
        where: { id: jobId, status: "BUILDING" },
        data: {
          status: "READY",
          partCount,
          totalSizeBytes: BigInt(totalSizeBytes),
          processedPhotos: 0,
          uploadProgress: 100,
          heartbeatAt: new Date(),
        },
      }).then((r) => r.count),
    catch: (e) => new Error(`Mark ready failed: ${e}`),
  });

const markFailed = (jobId: string, reason: string) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.updateMany({
        where: { id: jobId, status: "BUILDING" },
        data: { status: "FAILED", failureReason: reason, processedPhotos: 0 },
      }),
    catch: (e) => new Error(`Mark failed failed: ${e}`),
  });

// ---------------------------------------------------------------------------
// 5. Stream multi-part ZIPs to S3 with progress tracking + cancellation
// ---------------------------------------------------------------------------

// Reconcile the archive: rebuild STALE parts in place (from their stored
// membership, minus any deleted photos) and append brand-new parts for photos
// not yet assigned to any part. Immutable READY parts are left untouched.
const streamZipPartsToS3 = (eventId: string, photos: Photo[], jobId: string) =>
  Effect.gen(function* () {
    const { ZipArchive } = yield* Effect.tryPromise({
      try: () => import("archiver"),
      catch: (e) => new Error(`Archiver import failed: ${e}`),
    });
    const { PassThrough, Readable } = yield* Effect.tryPromise({
      try: () => import("node:stream"),
      catch: (e) => new Error(`Stream import failed: ${e}`),
    });
    const { Upload } = yield* Effect.tryPromise({
      try: () => import("@aws-sdk/lib-storage"),
      catch: (e) => new Error(`Lib-storage import failed: ${e}`),
    });

    const event = yield* Effect.tryPromise({
      try: () => prisma.event.findUnique({ where: { id: eventId }, select: { slug: true } }),
      catch: (e) => new Error(`Event lookup failed: ${e}`),
    });
    const folderName = event?.slug || eventId;

    const entryName = (photo: Photo) => {
      const name = (photo.photographerName || "unknown")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .toLowerCase();
      return `${folderName}/${name}/${photo.id}.jpg`;
    };

    const photoById = new Map(photos.map((p) => [p.id, p] as const));
    const processedIds = new Set(photos.map((p) => p.id));

    // Byte size of one photo entry, HEAD-probing S3 only for legacy rows.
    const entryBytesOf = (photo: Photo) =>
      Effect.tryPromise({
        try: async () => {
          let size = photo.sizeBytes;
          if (size === null || size === undefined) {
            const head = await s3.send(
              new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: photo.originalKey })
            );
            size = head.ContentLength ?? 0;
          }
          return zipEntryBytes(size, entryName(photo).length);
        },
        catch: (e) => new Error(`Head object failed for ${photo.originalKey}: ${e}`),
      });
    const estBytes = (list: Photo[]) =>
      list.reduce((s, p) => s + zipEntryBytes(p.sizeBytes ?? 0, entryName(p).length), 0);

    // ---- Load existing parts + their membership --------------------------
    const existingParts = yield* Effect.tryPromise({
      try: () =>
        prisma.downloadArchivePart.findMany({
          where: { jobId },
          include: { entries: true },
          orderBy: { partIndex: "asc" },
        }),
      catch: (e) => new Error(`Load parts failed: ${e}`),
    });
    const assignedIds = new Set<string>();
    for (const part of existingParts) for (const e of part.entries) assignedIds.add(e.photoId);

    // ---- Work A: STALE parts to rebuild from stored membership -----------
    const staleParts = existingParts.filter((p) => p.status === "STALE");

    // ---- Work B: unassigned processed photos → new parts -----------------
    const newPhotos = photos.filter((p) => !assignedIds.has(p.id)); // createdAt order preserved
    const newEntries: PlannedEntry<Photo>[] = [];
    for (const photo of newPhotos) {
      newEntries.push({ item: photo, entryBytes: yield* entryBytesOf(photo) });
    }
    const plannedNew = planArchiveParts(newEntries, env.DOWNLOAD_MAX_PART_BYTES);
    let maxIndex = existingParts.reduce((m, p) => Math.max(m, p.partIndex), 0);

    type Work =
      | { kind: "rebuild"; part: (typeof existingParts)[number]; photos: Photo[] }
      | { kind: "append"; partIndex: number; photos: Photo[]; estimatedBytes: number };
    const work: Work[] = [];
    for (const part of staleParts) {
      // Stored membership minus any now-deleted photos, ordered by createdAt.
      const members = part.entries
        .map((e) => photoById.get(e.photoId))
        .filter((p): p is Photo => p !== undefined && processedIds.has(p.id))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      work.push({ kind: "rebuild", part, photos: members });
    }
    for (const planned of plannedNew) {
      maxIndex += 1;
      work.push({ kind: "append", partIndex: maxIndex, photos: planned.items, estimatedBytes: planned.estimatedBytes });
    }

    const totalWorkPhotos = work.reduce((s, w) => s + w.photos.length, 0);
    const totalEstimatedBytes = work.reduce(
      (s, w) => s + (w.kind === "append" ? w.estimatedBytes : estBytes(w.photos)),
      0
    );

    const aggregate = () =>
      Effect.tryPromise({
        try: async () => {
          const live = await prisma.downloadArchivePart.findMany({ where: { jobId } });
          return { partCount: live.length, totalSizeBytes: live.reduce((s, p) => s + Number(p.sizeBytes), 0) };
        },
        catch: (e) => new Error(`Aggregate failed: ${e}`),
      });

    if (work.length === 0) {
      yield* Console.log(`[ZIP ${eventId}] reconcile: nothing to build`);
      return yield* aggregate();
    }

    yield* Console.log(
      `[ZIP ${eventId}] reconcile: ${staleParts.length} rebuild + ${plannedNew.length} new part(s), ${totalWorkPhotos} photos`
    );
    yield* Effect.tryPromise({
      try: () =>
        prisma.downloadJob.updateMany({
          where: { id: jobId, status: "BUILDING" },
          data: { photoCount: totalWorkPhotos, heartbeatAt: new Date() },
        }),
      catch: (e) => new Error(`Progress init failed: ${e}`),
    });

    // ---- Stream one photo list into one ZIP object -----------------------
    // Throws Error("CANCELLED") on admin cancel, Error("SUPERSEDED") when the
    // row is no longer BUILDING. Both abort the in-flight multipart upload.
    const streamOnePart = async (
      partPhotos: Photo[],
      key: string,
      label: string,
      processedOffset: number,
      completedBytes: number
    ): Promise<{ sizeBytes: number }> => {
      const passThrough = new PassThrough();

      // Bounded buffering: at most queueSize×partSize (~32 MB) of the archive
      // stream is held in memory, regardless of gallery size.
      const upload = new Upload({
        client: s3,
        params: { Bucket: env.S3_BUCKET, Key: key, Body: passThrough, ContentType: "application/zip" },
        partSize: 16 * 1024 * 1024,
        queueSize: 2,
      });

      let lastUploadPct = -1;
      upload.on("httpUploadProgress", (progress) => {
        const loaded = progress.loaded ?? 0;
        const pct =
          totalEstimatedBytes > 0
            ? Math.min(100, Math.round(((completedBytes + loaded) / totalEstimatedBytes) * 100))
            : 0;
        if (pct !== lastUploadPct && pct % 10 === 0) {
          lastUploadPct = pct;
          prisma.downloadJob
            .updateMany({ where: { id: jobId, status: "BUILDING" }, data: { uploadProgress: pct, heartbeatAt: new Date() } })
            .then(() => notifyDownloadStatus(eventId))
            .catch(() => {});
        }
      });

      const uploadPromise = upload.done();
      const archive = new ZipArchive({ store: true });
      const archiveFailure = new Promise<never>((_, reject) => {
        archive.on("error", (e: unknown) => reject(new Error(`Archive error: ${e}`)));
      });
      archive.pipe(passThrough);

      try {
        for (let i = 0; i < partPhotos.length; i++) {
          const photo = partPhotos[i];
          await checkStillBuilding(jobId);

          const { Body } = await s3.send(
            new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: photo.originalKey })
          );
          if (!Body) continue;

          const nodeStream = Body as unknown as InstanceType<typeof Readable>;
          await Promise.race([
            new Promise<void>((resolve, reject) => {
              nodeStream.once("end", resolve);
              nodeStream.once("error", reject);
              archive.append(nodeStream, { name: entryName(photo) });
            }),
            archiveFailure,
          ]);

          const processed = processedOffset + i + 1;
          if (processed % 3 === 0 || processed === totalWorkPhotos) {
            await prisma.downloadJob.updateMany({
              where: { id: jobId, status: "BUILDING" },
              data: { processedPhotos: processed, heartbeatAt: new Date() },
            });
            notifyDownloadStatus(eventId).catch(() => {});
          }
        }

        await checkStillBuilding(jobId);
        console.log(`[ZIP ${eventId}] finalizing ${label} (${partPhotos.length} photos)`);
        await Promise.race([archive.finalize(), archiveFailure]);
        await uploadPromise;
        console.log(`[ZIP ${eventId}] ${label} uploaded`);
      } catch (e) {
        await upload.abort().catch(() => {});
        throw e;
      }

      const head = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      return { sizeBytes: head.ContentLength ?? 0 };
    };

    const streamPart = (partPhotos: Photo[], key: string, label: string, off: number, done: number) =>
      Effect.tryPromise({
        try: () => streamOnePart(partPhotos, key, label, off, done),
        catch: (e) =>
          e instanceof Error && (e.message === "CANCELLED" || e.message === "SUPERSEDED")
            ? e
            : new Error(`${label} failed: ${e}`),
      });

    // ---- Execute the work list -------------------------------------------
    let processedOffset = 0;
    let completedBytes = 0;
    for (const w of work) {
      if (w.kind === "rebuild") {
        const part = w.part;
        if (w.photos.length === 0) {
          // Every member was deleted → drop the part (row + object). No renumber.
          yield* Effect.promise(async () => {
            if (part.key) await deleteS3Object(part.key).catch(() => {});
            await prisma.downloadArchivePart.delete({ where: { id: part.id } }).catch(() => {});
          });
          console.log(`[ZIP ${eventId}] part ${part.partIndex} emptied by deletions, removed`);
          continue;
        }
        const newGen = part.generation + 1;
        const key = s3Keys.zipPart(eventId, part.partIndex, newGen);
        const { sizeBytes } = yield* streamPart(
          w.photos, key, `part ${part.partIndex} (rebuild g${newGen})`, processedOffset, completedBytes
        );
        const sig = membershipSig(w.photos.map((p) => p.id));
        const oldKey = part.key;
        yield* Effect.tryPromise({
          try: () =>
            prisma.$transaction(async (tx) => {
              await tx.downloadArchivePartEntry.deleteMany({ where: { partId: part.id } });
              await tx.downloadArchivePartEntry.createMany({
                data: w.photos.map((p) => ({ partId: part.id, photoId: p.id })),
              });
              await tx.downloadArchivePart.update({
                where: { id: part.id },
                data: { key, generation: newGen, sizeBytes: BigInt(sizeBytes), photoCount: w.photos.length, membershipSig: sig, status: "READY" },
              });
            }),
          catch: (e) => new Error(`Part ${part.partIndex} commit failed: ${e}`),
        });
        // Old generation object no longer referenced — remove it now.
        if (oldKey && oldKey !== key) yield* Effect.promise(() => deleteS3Object(oldKey).catch(() => {}));
        processedOffset += w.photos.length;
        completedBytes += estBytes(w.photos);
      } else {
        const gen = 1;
        const key = s3Keys.zipPart(eventId, w.partIndex, gen);
        const { sizeBytes } = yield* streamPart(
          w.photos, key, `part ${w.partIndex} (new)`, processedOffset, completedBytes
        );
        const sig = membershipSig(w.photos.map((p) => p.id));
        yield* Effect.tryPromise({
          try: () =>
            prisma.$transaction(async (tx) => {
              const created = await tx.downloadArchivePart.create({
                data: { jobId, partIndex: w.partIndex, key, generation: gen, sizeBytes: BigInt(sizeBytes), photoCount: w.photos.length, membershipSig: sig, status: "READY" },
              });
              await tx.downloadArchivePartEntry.createMany({
                data: w.photos.map((p) => ({ partId: created.id, photoId: p.id })),
              });
            }),
          catch: (e) => new Error(`Part ${w.partIndex} insert failed: ${e}`),
        });
        processedOffset += w.photos.length;
        completedBytes += w.estimatedBytes;
      }
    }

    // ---- Orphan sweep: drop archive objects not referenced by a live part
    // (old generations, pre-migration unversioned parts, crash leftovers).
    yield* Effect.promise(async () => {
      const live = await prisma.downloadArchivePart.findMany({ where: { jobId }, select: { key: true } });
      const liveKeys = new Set(live.map((p) => p.key).filter(Boolean));
      const listed = await listS3Prefix(s3Keys.archivePrefix(eventId)).catch(() => [] as string[]);
      const orphans = listed.filter((k) => !liveKeys.has(k));
      for (const k of orphans) await deleteS3Object(k).catch(() => {});
      if (orphans.length) console.log(`[ZIP ${eventId}] swept ${orphans.length} orphan archive object(s)`);
    });

    return yield* aggregate();
  });

// Abort signal for an in-flight build: CANCELLED when the admin cancelled,
// SUPERSEDED when a re-queue (build-now/rebuild-all) reset the row (it is QUEUED/DEBOUNCING again and
// a fresh build owns the archive prefix).
async function checkStillBuilding(jobId: string): Promise<void> {
  const job = await prisma.downloadJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  if (job?.status === "CANCELLED") throw new Error("CANCELLED");
  if (job?.status !== "BUILDING") throw new Error("SUPERSEDED");
}
