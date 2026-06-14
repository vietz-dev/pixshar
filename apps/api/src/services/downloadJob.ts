import { Effect, Schedule, Console } from "effect";
import { prisma } from "../lib/prisma.js";
import { s3, s3Keys, deleteS3Object } from "../lib/s3.js";
import { env } from "../lib/env.js";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { Photo } from "@prisma/client";

// ---------------------------------------------------------------------------
// 1. Debounce trigger — called after every successful photo processing
// ---------------------------------------------------------------------------

export async function triggerDebounce(eventId: string): Promise<void> {
  const debounceMs = env.DOWNLOAD_DEBOUNCE_SECONDS * 1000;
  const debounceUntil = new Date(Date.now() + debounceMs);
  console.log(`[Debounce] event=${eventId} debounceUntil=${debounceUntil.toISOString()}`);

  await prisma.$transaction(async (tx) => {
    // Increment processed photo count
    await tx.event.update({
      where: { id: eventId },
      data: { processedPhotoCount: { increment: 1 } },
    });

    // Upsert DownloadJob with state-machine transitions
    const existing = await tx.downloadJob.findUnique({
      where: { eventId },
    });

    if (!existing) {
      await tx.downloadJob.create({
        data: {
          eventId,
          status: "DEBOUNCING",
          debounceUntil,
        },
      });
      console.log(`[Debounce] event=${eventId} created new DEBOUNCING job`);
      return;
    }

    switch (existing.status) {
      case "DEBOUNCING": {
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
          data: { status: "DEBOUNCING", debounceUntil, processedPhotos: 0 },
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
        await tx.downloadJob.update({
          where: { id: existing.id },
          data: {
            status: "DEBOUNCING",
            debounceUntil,
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
          data: { status: "DEBOUNCING", debounceUntil, failureReason: null, processedPhotos: 0 },
        });
        console.log(`[Debounce] event=${eventId} ${existing.status} -> DEBOUNCING`);
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Debounce poller — background loop
// ---------------------------------------------------------------------------

let pollerInterval: ReturnType<typeof setInterval> | null = null;

export function startDebouncePoller(): void {
  if (pollerInterval) {
    console.log(`[Poller] already running (interval=${pollerInterval})`);
    return;
  }

  console.log(`[Poller] starting…`);

  // Recover stale BUILDING jobs (> 30 min) back to QUEUED
  prisma.downloadJob
    .updateMany({
      where: {
        status: "BUILDING",
        updatedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
      },
      data: { status: "QUEUED", processedPhotos: 0 },
    })
    .then((result) => {
      console.log(`[Poller] recovery done, recovered ${result.count} stale BUILDING jobs`);
      pollerInterval = setInterval(() => {
        checkDebounceTimers().catch(() => {});
      }, 60_000);
      console.log(`[Poller] interval set (60s)`);
    })
    .catch((e) => {
      console.error(`[Poller] recovery failed: ${e}`);
    });
}

async function checkDebounceTimers(): Promise<void> {
  const now = new Date();
  console.log(`[Poller] tick at ${now.toISOString()}`);

  const ready = await prisma.downloadJob.findMany({
    where: {
      status: "DEBOUNCING",
      debounceUntil: { lte: now },
    },
  });

  console.log(`[Poller] found ${ready.length} expired DEBOUNCING job(s)`);

  for (const job of ready) {
    console.log(`[Poller] queuing build for event=${job.eventId}`);
    await prisma.downloadJob.update({
      where: { id: job.id },
      data: { status: "QUEUED", processedPhotos: 0 },
    });
    runBuildZip(job.eventId);
  }
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
    runBuildZip(eventId);
    return;
  }

  // Delete any existing S3 ZIP so the old build can't overwrite with stale data
  if (job.zipKey) {
    await deleteS3Object(job.zipKey).catch(() => {});
    console.log(`[ForceBuild] event=${eventId} deleted old S3 zip`);
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

  runBuildZip(eventId);
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

    const photos = yield* loadPhotos(eventId);
    console.log(`[BuildZip] event=${eventId} loaded ${photos.length} photos`);
    yield* markBuilding(job.id, photos.length);

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

    console.log(`[BuildZip] event=${eventId} marking READY (zipSize=${result.zipSizeBytes})`);
    yield* markReady(job.id, result.zipKey, result.zipSizeBytes);
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
          data: { status: "BUILDING", processedPhotos: 0 },
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

const markBuilding = (jobId: string, photoCount: number) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.update({
        where: { id: jobId },
        data: { photoCount, processedPhotos: 0 },
      }),
    catch: (e) => new Error(`Mark building failed: ${e}`),
  });

const markReady = (jobId: string, zipKey: string, zipSizeBytes: number) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.update({
        where: { id: jobId },
        data: { status: "READY", zipKey, zipSizeBytes, processedPhotos: 0, uploadProgress: 100 },
      }),
    catch: (e) => new Error(`Mark ready failed: ${e}`),
  });

const markUploading = (jobId: string) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.update({
        where: { id: jobId },
        data: { processedPhotos: -1, uploadProgress: 0 },
      }),
    catch: (e) => new Error(`Mark uploading failed: ${e}`),
  });

const updateUploadProgress = (jobId: string, pct: number) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.update({
        where: { id: jobId },
        data: { uploadProgress: pct },
      }),
    catch: (e) => new Error(`Upload progress update failed: ${e}`),
  });

const markFailed = (jobId: string, reason: string) =>
  Effect.tryPromise({
    try: () =>
      prisma.downloadJob.update({
        where: { id: jobId },
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
    const { PassThrough } = yield* Effect.tryPromise({
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
        prisma.downloadJob.update({
          where: { id: jobId },
          data: { uploadProgress: pct },
        }).catch(() => {});
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
      const buffer = yield* Effect.tryPromise({
        try: () => Body.transformToByteArray(),
        catch: (e) => new Error(`Buffer read failed: ${e}`),
      });
      archive.append(Buffer.from(buffer), { name: filename });

      // Update progress every 3 photos (throttle DB writes)
      if ((i + 1) % 3 === 0 || i === photos.length - 1) {
        yield* updateProgress(jobId, i + 1);
      }
    }

    yield* checkNotCancelled(jobId);
    yield* markUploading(jobId);
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
      prisma.downloadJob.update({
        where: { id: jobId },
        data: { processedPhotos: processed },
      }),
    catch: (e) => new Error(`Progress update failed: ${e}`),
  });
