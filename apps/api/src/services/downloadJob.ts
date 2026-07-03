import { Effect, Schedule, Console } from "effect";
import { prisma } from "../lib/prisma.js";
import { s3, s3Keys, deleteS3Prefix, getPresignedUrl } from "../lib/s3.js";
import { env } from "../lib/env.js";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { Photo } from "@prisma/client";
import { emitDownloadStatus, PG_NOTIFY_CHANNEL } from "../lib/eventBus.js";
import { planArchiveParts, zipEntryBytes } from "./archivePlanner.js";

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

// Best-effort removal of all archive artifacts (part rows + S3 objects).
async function deleteArchiveArtifacts(eventId: string, jobId: string): Promise<void> {
  await prisma.downloadArchivePart.deleteMany({ where: { jobId } }).catch(() => {});
  await deleteS3Prefix(s3Keys.archivePrefix(eventId))
    .then((n) => {
      if (n > 0) console.log(`[Archive] event=${eventId} deleted ${n} stale archive object(s)`);
    })
    .catch((e) => console.error(`[Archive] event=${eventId} failed to delete archive prefix: ${e}`));
}

// ---------------------------------------------------------------------------
// 1. Debounce trigger — called after every successful photo processing
// ---------------------------------------------------------------------------

export async function triggerDebounce(eventId: string): Promise<void> {
  const now = Date.now();
  const debounceUntil = new Date(now + env.DOWNLOAD_DEBOUNCE_SECONDS * 1000);
  const debounceStartedAt = new Date(now);
  console.log(`[Debounce] event=${eventId} debounceUntil=${debounceUntil.toISOString()}`);

  // A stale READY archive must be deleted from S3 once it's superseded — flag it
  // inside the tx and delete after commit (no S3 calls inside a tx).
  let staleArchiveJobId: string | null = null;

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
        staleArchiveJobId = existing.id;
        await tx.downloadJob.update({
          where: { id: existing.id },
          data: {
            status: "DEBOUNCING",
            debounceUntil,
            debounceStartedAt,
            totalSizeBytes: null,
            partCount: 0,
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

  if (staleArchiveJobId) {
    deleteArchiveArtifacts(eventId, staleArchiveJobId).catch(() => {});
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

  // Enqueue all QUEUED jobs (incl. forceBuild ones, which bypass DEBOUNCING)
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

export async function forceBuild(eventId: string): Promise<void> {
  const job = await prisma.downloadJob.findUnique({ where: { eventId } });

  if (!job) {
    await prisma.downloadJob.create({
      data: { eventId, status: "QUEUED", queuedAt: new Date(), processedPhotos: 0, uploadProgress: 0 },
    });
    console.log(`[ForceBuild] event=${eventId} created new QUEUED job`);
    notifyDownloadStatus(eventId).catch(() => {});
    // Worker's debounce poller picks up QUEUED within its next cycle (~15s).
    return;
  }

  // Delete any existing archive parts so the old build can't serve stale data
  await deleteArchiveArtifacts(eventId, job.id);

  // Reset job to QUEUED regardless of current state — this cancels debounce,
  // aborts an in-flight build (old fiber sees status change), and starts fresh.
  await prisma.downloadJob.update({
    where: { id: job.id },
    data: {
      status: "QUEUED",
      queuedAt: new Date(),
      processedPhotos: 0,
      uploadProgress: 0,
      failureReason: null,
      totalSizeBytes: null,
      partCount: 0,
    },
  });
  console.log(`[ForceBuild] event=${eventId} reset job to QUEUED (was ${job.status})`);
  notifyDownloadStatus(eventId).catch(() => {});
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
  notifyDownloadStatus(eventId).catch(() => {});

  // If partial archive parts exist on S3, delete them. An in-flight build also
  // cleans up after itself when it observes the CANCELLED status.
  await deleteArchiveArtifacts(eventId, job.id);
}

export interface ReadyDownloadPayload {
  status: "READY";
  parts: { index: number; url: string; sizeBytes: number }[];
  partCount: number;
  totalSizeBytes: number;
  photoCount: number;
}

// Presigned download links for every archive part of a READY job. The
// Content-Disposition filename carries part numbering so a guest saving
// three parts ends up with `<slug>-part-1-of-3.zip` etc.
export async function buildReadyDownloadPayload(
  jobId: string,
  slug: string,
  photoCount: number,
  expiresIn = 60 * 60
): Promise<ReadyDownloadPayload> {
  const rows = await prisma.downloadArchivePart.findMany({
    where: { jobId },
    orderBy: { partIndex: "asc" },
  });
  const n = rows.length;
  const parts = await Promise.all(
    rows.map(async (p) => ({
      index: p.partIndex,
      sizeBytes: Number(p.sizeBytes),
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
    photoCount,
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
        if (e.message === "CANCELLED") {
          return Effect.promise(async () => {
            await deleteArchiveArtifacts(eventId, job.id);
            return undefined;
          }).pipe(Effect.orElseSucceed(() => undefined));
        }
        if (e.message === "SUPERSEDED") {
          // A forceBuild reset the row while we were building — the next build
          // owns the archive prefix now, so just walk away.
          console.log(`[BuildZip] event=${eventId} superseded mid-build, aborting`);
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
      // Superseded by a forceBuild (row no longer BUILDING) — drop this result.
      console.log(`[BuildZip] event=${eventId} markReady no-op (superseded), skipping push`);
      return;
    }
    console.log(
      `[BuildZip] event=${eventId} marked READY (parts=${result.partCount}, totalSize=${result.totalSizeBytes})`
    );
    yield* Effect.promise(() => notifyDownloadStatus(eventId).catch(() => {}));
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

interface PlannedPart {
  photos: Photo[];
  estimatedBytes: number;
}

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

    // Restart-clean: drop anything a previous attempt (retry or reaped crash)
    // left behind, in DB and on S3.
    yield* Effect.promise(() => deleteArchiveArtifacts(eventId, jobId));

    const event = yield* Effect.tryPromise({
      try: () =>
        prisma.event.findUnique({
          where: { id: eventId },
          select: { slug: true },
        }),
      catch: (e) => new Error(`Event lookup failed: ${e}`),
    });
    const folderName = event?.slug || eventId;

    const entryName = (photo: Photo) => {
      const name = (photo.photographerName || "unknown")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .toLowerCase();
      return `${folderName}/${name}/${photo.id}.jpg`;
    };

    // ---- Plan parts: greedy fill up to the byte limit --------------------
    const entries: { item: Photo; entryBytes: number }[] = [];
    for (const photo of photos) {
      let size = photo.sizeBytes;
      if (size === null || size === undefined) {
        // Legacy rows without sizeBytes: one HEAD per unknown photo.
        const head = yield* Effect.tryPromise({
          try: () =>
            s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: photo.originalKey })),
          catch: (e) => new Error(`Head object failed for ${photo.originalKey}: ${e}`),
        });
        size = head.ContentLength ?? 0;
      }
      entries.push({ item: photo, entryBytes: zipEntryBytes(size, entryName(photo).length) });
    }
    const parts: PlannedPart[] = planArchiveParts(entries, env.DOWNLOAD_MAX_PART_BYTES).map(
      (p) => ({ photos: p.items, estimatedBytes: p.estimatedBytes })
    );

    const totalEstimatedBytes = parts.reduce((sum, p) => sum + p.estimatedBytes, 0);
    yield* Console.log(
      `[ZIP ${eventId}] planned ${parts.length} part(s) for ${photos.length} photos (~${totalEstimatedBytes} bytes, limit=${env.DOWNLOAD_MAX_PART_BYTES})`
    );

    // Expose the planned part count to the UI while building.
    yield* Effect.tryPromise({
      try: () =>
        prisma.downloadJob.updateMany({
          where: { id: jobId, status: "BUILDING" },
          data: { partCount: parts.length, heartbeatAt: new Date() },
        }),
      catch: (e) => new Error(`Part count update failed: ${e}`),
    });

    // ---- Stream each part -------------------------------------------------
    // Throws Error("CANCELLED") on admin cancel, Error("SUPERSEDED") when a
    // forceBuild reset the row mid-build. Both abort the in-flight multipart
    // upload so Minio/S3 doesn't accumulate orphaned upload parts.
    const streamOnePart = async (
      part: PlannedPart,
      partIndex: number,
      processedOffset: number,
      completedBytes: number
    ): Promise<{ key: string; sizeBytes: number }> => {
      const key = s3Keys.zipPart(eventId, partIndex);
      const passThrough = new PassThrough();

      // Bounded buffering: at most queueSize×partSize (~32 MB) of the archive
      // stream is held in memory, regardless of gallery size. 16 MB parts keep
      // us far below the S3 limit of 10 000 multipart chunks per object.
      const upload = new Upload({
        client: s3,
        params: {
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: passThrough,
          ContentType: "application/zip",
        },
        partSize: 16 * 1024 * 1024,
        queueSize: 2,
      });

      // Overall byte-based progress across all parts, throttled to 10% steps.
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
            .updateMany({
              where: { id: jobId, status: "BUILDING" },
              data: { uploadProgress: pct, heartbeatAt: new Date() },
            })
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
        for (let i = 0; i < part.photos.length; i++) {
          const photo = part.photos[i];

          await checkStillBuilding(jobId);

          const { Body } = await s3.send(
            new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: photo.originalKey })
          );
          if (!Body) continue;

          // AWS SDK v3 Body is a Node.js Readable in Bun/Node environments via
          // SdkStreamMixin. archiver reads it with backpressure from the
          // PassThrough, so only small stream buffers sit in memory.
          const nodeStream = Body as unknown as InstanceType<typeof Readable>;
          await Promise.race([
            new Promise<void>((resolve, reject) => {
              nodeStream.once("end", resolve);
              nodeStream.once("error", reject);
              archive.append(nodeStream, { name: entryName(photo) });
            }),
            archiveFailure,
          ]);

          // Update progress every 3 photos (throttle DB writes)
          const processed = processedOffset + i + 1;
          if (processed % 3 === 0 || processed === photos.length) {
            await prisma.downloadJob.updateMany({
              where: { id: jobId, status: "BUILDING" },
              data: { processedPhotos: processed, heartbeatAt: new Date() },
            });
            notifyDownloadStatus(eventId).catch(() => {});
          }
        }

        await checkStillBuilding(jobId);
        console.log(`[ZIP ${eventId}] finalizing part ${partIndex} (${part.photos.length} photos)`);
        await Promise.race([archive.finalize(), archiveFailure]);
        await uploadPromise;
        console.log(`[ZIP ${eventId}] part ${partIndex} uploaded`);
      } catch (e) {
        await upload.abort().catch(() => {});
        throw e;
      }

      const head = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      return { key, sizeBytes: head.ContentLength ?? 0 };
    };

    let processedOffset = 0;
    let completedBytes = 0;
    let totalSizeBytes = 0;
    for (let p = 0; p < parts.length; p++) {
      const partIndex = p + 1;
      const { key, sizeBytes } = yield* Effect.tryPromise({
        try: () => streamOnePart(parts[p], partIndex, processedOffset, completedBytes),
        catch: (e) =>
          e instanceof Error && (e.message === "CANCELLED" || e.message === "SUPERSEDED")
            ? e
            : new Error(`Part ${partIndex} failed: ${e}`),
      });

      yield* Effect.tryPromise({
        try: () =>
          prisma.downloadArchivePart.create({
            data: { jobId, partIndex, key, sizeBytes: BigInt(sizeBytes) },
          }),
        catch: (e) => new Error(`Part row insert failed: ${e}`),
      });

      processedOffset += parts[p].photos.length;
      completedBytes += parts[p].estimatedBytes;
      totalSizeBytes += sizeBytes;
    }

    return { partCount: parts.length, totalSizeBytes };
  });

// Abort signal for an in-flight build: CANCELLED when the admin cancelled,
// SUPERSEDED when a forceBuild reset the row (it's QUEUED/DEBOUNCING again and
// a fresh build owns the archive prefix).
async function checkStillBuilding(jobId: string): Promise<void> {
  const job = await prisma.downloadJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  if (job?.status === "CANCELLED") throw new Error("CANCELLED");
  if (job?.status !== "BUILDING") throw new Error("SUPERSEDED");
}
