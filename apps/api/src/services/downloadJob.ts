import { Effect, Schedule, Console } from "effect";
import { prisma } from "../lib/prisma.js";
import { s3, s3Keys, deleteS3Object } from "../lib/s3.js";
import { env } from "../lib/env.js";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { Photo } from "@prisma/client";
import { emitDownloadStatus } from "../lib/eventBus.js";

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
    zipSizeBytes: job.zipSizeBytes,
    debounceUntil: job.debounceUntil?.toISOString() ?? null,
    failureReason: job.failureReason,
    updatedAt: job.updatedAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// 1. Debounce trigger — called after every successful photo processing
// ---------------------------------------------------------------------------

export async function triggerDebounce(eventId: string): Promise<void> {
  const now = Date.now();
  const debounceUntil = new Date(now + env.DOWNLOAD_DEBOUNCE_SECONDS * 1000);
  const debounceStartedAt = new Date(now);
  console.log(`[Debounce] event=${eventId} debounceUntil=${debounceUntil.toISOString()}`);

  // A stale READY zip must be deleted from S3 once it's superseded — capture the
  // key inside the tx and delete after commit (no S3 calls inside a tx).
  let staleZipKey: string | null = null;

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
          data: { status: "DEBOUNCING", debounceUntil, debounceStartedAt, processedPhotos: 0 },
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
        staleZipKey = existing.zipKey;
        await tx.downloadJob.update({
          where: { id: existing.id },
          data: {
            status: "DEBOUNCING",
            debounceUntil,
            debounceStartedAt,
            zipKey: null,
            zipSizeBytes: null,
            processedPhotos: 0,
          },
        });
        console.log(`[Debounce] event=${eventId} READY -> DEBOUNCING`);
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

  if (staleZipKey) {
    deleteS3Object(staleZipKey)
      .then(() => console.log(`[Debounce] event=${eventId} deleted stale READY zip`))
      .catch((e) => console.error(`[Debounce] event=${eventId} failed to delete stale zip: ${e}`));
  }
  pushDownloadStatus(eventId).catch(() => {});
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

  // Build when the quiet period elapsed OR the max-wait ceiling is hit (so a
  // continuous stream of uploads can't starve the archive indefinitely).
  const ready = await prisma.downloadJob.findMany({
    where: {
      status: "DEBOUNCING",
      OR: [
        { debounceUntil: { lte: now } },
        { debounceStartedAt: { lte: maxWaitCutoff } },
      ],
    },
  });

  for (const job of ready) {
    // Count-checked transition so two replicas can't both launch a build.
    const res = await prisma.downloadJob.updateMany({
      where: { id: job.id, status: "DEBOUNCING" },
      data: { status: "QUEUED", processedPhotos: 0 },
    });
    if (res.count !== 1) continue;
    console.log(`[Poller] queuing build for event=${job.eventId}`);
    pushDownloadStatus(job.eventId).catch(() => {});
    runBuildZip(job.eventId);
  }

  // Also pick up any QUEUED jobs created by forceBuild (which bypasses DEBOUNCING).
  // runBuildZip atomically claims QUEUED→BUILDING so concurrent workers are safe.
  const queued = await prisma.downloadJob.findMany({
    where: { status: "QUEUED" },
  });
  for (const job of queued) {
    console.log(`[Poller] building queued job for event=${job.eventId}`);
    runBuildZip(job.eventId);
  }
}

// ---------------------------------------------------------------------------
// 2b. Stale-BUILDING reaper — recover a build a crashed pod left mid-flight.
// ---------------------------------------------------------------------------

export async function reapStaleBuilding(): Promise<number> {
  const cutoff = new Date(Date.now() - env.DOWNLOAD_BUILD_LEASE_SECONDS * 1000);
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

export async function forceBuild(eventId: string): Promise<void> {
  const job = await prisma.downloadJob.findUnique({ where: { eventId } });

  if (!job) {
    await prisma.downloadJob.create({
      data: { eventId, status: "QUEUED", processedPhotos: 0, uploadProgress: 0 },
    });
    console.log(`[ForceBuild] event=${eventId} created new QUEUED job`);
    pushDownloadStatus(eventId).catch(() => {});
    // Worker's debounce poller picks up QUEUED within its next cycle (~15s).
    return;
  }

  // Delete any existing S3 ZIP so the old build can't overwrite with stale data
  if (job.zipKey) {
    await deleteS3Object(job.zipKey)
      .then(() => console.log(`[ForceBuild] event=${eventId} deleted old S3 zip`))
      .catch((e) => console.error(`[ForceBuild] event=${eventId} failed to delete old zip: ${e}`));
  }

  // Reset job to QUEUED regardless of current state — this cancels debounce,
  // aborts an in-flight build (old fiber sees status change), and starts fresh.
  await prisma.downloadJob.update({
    where: { id: job.id },
    data: {
      status: "QUEUED",
      processedPhotos: 0,
      uploadProgress: 0,
      failureReason: null,
      zipKey: null,
      zipSizeBytes: null,
    },
  });
  console.log(`[ForceBuild] event=${eventId} reset job to QUEUED (was ${job.status})`);
  pushDownloadStatus(eventId).catch(() => {});
  // Worker's debounce poller picks up QUEUED within its next cycle (~15s).
}

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
  pushDownloadStatus(eventId).catch(() => {});

  // If a partial zip exists on S3, delete it
  if (job.zipKey) {
    await deleteS3Object(job.zipKey).catch(() => {});
  }
}

export async function getDownloadJobStatus(eventId: string) {
  const job = await prisma.downloadJob.findUnique({
    where: { eventId },
  });
  if (!job) return null;

  return {
    id: job.id,
    status: job.status,
    photoCount: job.photoCount,
    processedPhotos: job.processedPhotos,
    uploadProgress: job.uploadProgress,
    zipSizeBytes: job.zipSizeBytes,
    debounceUntil: job.debounceUntil,
    failureReason: job.failureReason,
    updatedAt: job.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// 4. ZIP build pipeline
// ---------------------------------------------------------------------------

export function runBuildZip(eventId: string): void {
  console.log(`[BuildZip] starting for event=${eventId}`);
  Effect.runFork(buildZip(eventId));
}

const buildZip = (eventId: string) =>
  Effect.gen(function* () {
    const job = yield* claimJob(eventId);
    if (!job) {
      console.log(`[BuildZip] event=${eventId} claim failed, aborting`);
      return;
    }
    console.log(`[BuildZip] event=${eventId} claimed job ${job.id}`);
    yield* Effect.promise(() => pushDownloadStatus(eventId).catch(() => {}));

    const photos = yield* loadPhotos(eventId);
    console.log(`[BuildZip] event=${eventId} loaded ${photos.length} photos`);
    yield* markBuilding(job.id, photos.length);
    yield* Effect.promise(() => pushDownloadStatus(eventId).catch(() => {}));

    // Retry only the S3 streaming part — claimJob must NOT be retried
    // because it atomically transitions QUEUED→BUILDING and a second
    // attempt would see BUILDING and return null (broken retry).
    const result = yield* streamZipToS3(eventId, photos, job.id).pipe(
      // Catch CANCELLED before retry — do NOT retry on user cancel
      Effect.catchAll((e) => {
        if (e.message === "CANCELLED") {
          return Effect.promise(() =>
            prisma.downloadJob.update({
              where: { eventId },
              data: { failureReason: "Cancelled by admin" },
            }).then(() => undefined)
          ).pipe(Effect.orElseSucceed(() => undefined));
        }
        return Effect.fail(e);
      }),
      Effect.retry({
        times: 3,
        schedule: Schedule.exponential("1 second"),
      })
    );

    if (!result) {
      console.log(`[BuildZip] event=${eventId} cancelled, skipping markReady`);
      return;
    }

    const readyCount = yield* markReady(job.id, result.zipKey, result.zipSizeBytes);
    if (readyCount === 0) {
      // Superseded by a forceBuild (row no longer BUILDING) — drop this result.
      console.log(`[BuildZip] event=${eventId} markReady no-op (superseded), skipping push`);
      return;
    }
    console.log(`[BuildZip] event=${eventId} marked READY (zipSize=${result.zipSizeBytes})`);
    yield* Effect.promise(() => pushDownloadStatus(eventId).catch(() => {}));
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
          yield* Effect.promise(() => pushDownloadStatus(eventId).catch(() => {}));
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
// concurrent forceBuild (which resets the row to QUEUED) makes a stale fiber's
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
// (the build was superseded by a forceBuild).
const markReady = (jobId: string, zipKey: string, zipSizeBytes: number) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.updateMany({
        where: { id: jobId, status: "BUILDING" },
        data: { status: "READY", zipKey, zipSizeBytes, processedPhotos: 0, uploadProgress: 100, heartbeatAt: new Date() },
      }).then((r) => r.count),
    catch: (e) => new Error(`Mark ready failed: ${e}`),
  });

const markUploading = (jobId: string) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.updateMany({
        where: { id: jobId, status: "BUILDING" },
        data: { processedPhotos: -1, uploadProgress: 0, heartbeatAt: new Date() },
      }),
    catch: (e) => new Error(`Mark uploading failed: ${e}`),
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
// 5. Stream ZIP to S3 with progress tracking + cancellation checks
// ---------------------------------------------------------------------------

const streamZipToS3 = (eventId: string, photos: Photo[], jobId: string) =>
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

    const zipKey = s3Keys.zip(eventId);
    const passThrough = new PassThrough();

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: env.S3_BUCKET,
        Key: zipKey,
        Body: passThrough,
        ContentType: "application/zip",
      },
    });

    // Track upload progress via S3 events
    let lastUploadPct = 0;
    upload.on("httpUploadProgress", (progress) => {
      const total = progress.total ?? 0;
      const loaded = progress.loaded ?? 0;
      const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
      // Throttle DB writes: only update every 10%
      if (pct !== lastUploadPct && pct % 10 === 0) {
        lastUploadPct = pct;
        prisma.downloadJob.updateMany({
          where: { id: jobId, status: "BUILDING" },
          data: { uploadProgress: pct, heartbeatAt: new Date() },
        }).then(() => pushDownloadStatus(eventId)).catch(() => {});
      }
    });

    // Start the upload in the background immediately — it will read from the
    // PassThrough as data becomes available.
    const uploadPromise = upload.done();

    const archive = new ZipArchive({ store: true });
    archive.pipe(passThrough);

    const event = yield* Effect.tryPromise({
      try: () =>
        prisma.event.findUnique({
          where: { id: eventId },
          select: { slug: true },
        }),
      catch: (e) => new Error(`Event lookup failed: ${e}`),
    });
    const folderName = event?.slug || eventId;

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];

      // Check for cancellation before each photo
      yield* checkNotCancelled(jobId);

      const getCmd = new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: photo.originalKey,
      });
      const { Body } = yield* Effect.tryPromise({
        try: () => s3.send(getCmd),
        catch: (e) => new Error(`S3 get failed: ${e}`),
      });
      if (!Body) continue;

      const name = (photo.photographerName || "unknown")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .toLowerCase();
      const filename = `${folderName}/${name}/${photo.id}.jpg`;
      // AWS SDK v3 Body is a Node.js Readable in Bun/Node environments via SdkStreamMixin
      const nodeStream = Body as unknown as InstanceType<typeof Readable>;
      yield* Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            nodeStream.once("end", resolve);
            nodeStream.once("error", reject);
            archive.append(nodeStream, { name: filename });
          }),
        catch: (e) => new Error(`Stream append failed: ${e}`),
      });

      // Update progress every 3 photos (throttle DB writes)
      if ((i + 1) % 3 === 0 || i === photos.length - 1) {
        yield* updateProgress(jobId, i + 1);
        yield* Effect.promise(() => pushDownloadStatus(eventId).catch(() => {}));
      }
    }

    yield* checkNotCancelled(jobId);
    yield* markUploading(jobId);
    yield* Effect.promise(() => pushDownloadStatus(eventId).catch(() => {}));
    yield* Console.log(`[ZIP ${eventId}] finalizing archive (${photos.length} photos)`);
    yield* Effect.tryPromise({
      try: () => archive.finalize(),
      catch: (e) => new Error(`Archive finalize failed: ${e}`),
    });
    yield* Console.log(`[ZIP ${eventId}] archive finalized, waiting for S3 upload…`);
    yield* Effect.tryPromise({
      try: () => uploadPromise,
      catch: (e) => new Error(`S3 upload failed: ${e}`),
    });
    yield* Console.log(`[ZIP ${eventId}] S3 upload complete`);

    const head = yield* Effect.tryPromise({
      try: () =>
        s3.send(
          new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: zipKey })
        ),
      catch: (e) => new Error(`Head object failed: ${e}`),
    });
    const zipSizeBytes = head.ContentLength ?? 0;

    return { zipKey, zipSizeBytes };
  });

const checkNotCancelled = (jobId: string) =>
  Effect.tryPromise({
    try: async () => {
      const job = await prisma.downloadJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      if (job?.status === "CANCELLED") {
        throw new Error("CANCELLED");
      }
    },
    catch: (e) =>
      e instanceof Error && e.message === "CANCELLED"
        ? e
        : new Error(`Cancel check failed: ${e}`),
  });

const updateProgress = (jobId: string, processed: number) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.updateMany({
        where: { id: jobId, status: "BUILDING" },
        data: { processedPhotos: processed, heartbeatAt: new Date() },
      }),
    catch: (e) => new Error(`Progress update failed: ${e}`),
  });
