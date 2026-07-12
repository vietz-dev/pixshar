import { Effect, Schedule, Console } from "effect";
import { prisma } from "../../lib/prisma.js";
import { s3, s3Keys, deleteS3Object, listS3Prefix } from "../../lib/s3.js";
import { env } from "../../lib/env.js";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { Photo } from "@prisma/client";
import { planArchiveParts, zipEntryBytes, type PlannedEntry } from "../archivePlanner.js";
import { DEFAULT_QUALITY, jobWhere, membershipSig, notifyDownloadStatus, type Quality } from "./status.js";
import { expirePartsForMissingPhotos } from "./deletion.js";

// The S3 source key a variant zips for a given photo.
function sourceKey(photo: Photo, quality: Quality): string {
  return quality === "DISPLAY" ? photo.displayKey : photo.originalKey;
}

// ---------------------------------------------------------------------------
// 4. ZIP build pipeline — serialized per process
// ---------------------------------------------------------------------------

// Exactly one archive build runs at a time in this process, FIFO. A single
// image-processor container must keep resizing photos while it builds one
// archive; concurrent builds would multiply peak memory and I/O. Multiple
// worker replicas can still build *different* events in parallel because
// claimJob's QUEUED→BUILDING CAS hands each event to exactly one replica.
// Keyed by `${eventId}:${quality}` so the two variants of one event are
// independently claimable build units and never collapse into a single entry.
const enqueuedBuilds = new Set<string>();
let buildChain: Promise<void> = Promise.resolve();

export function runBuildZip(eventId: string, quality: Quality = DEFAULT_QUALITY): void {
  const buildKey = `${eventId}:${quality}`;
  if (enqueuedBuilds.has(buildKey)) return;
  enqueuedBuilds.add(buildKey);
  console.log(`[BuildZip] enqueued event=${eventId} quality=${quality} (queue depth=${enqueuedBuilds.size})`);
  buildChain = buildChain.then(async () => {
    try {
      await Effect.runPromise(buildZip(eventId, quality));
    } catch (e) {
      console.error(`[BuildZip] event=${eventId} quality=${quality} unexpected failure: ${e}`);
    } finally {
      enqueuedBuilds.delete(buildKey);
    }
  });
}

const buildZip = (eventId: string, quality: Quality) =>
  Effect.gen(function* () {
    const job = yield* claimJob(eventId, quality);
    if (!job) {
      console.log(`[BuildZip] event=${eventId} quality=${quality} claim failed, aborting`);
      return;
    }
    console.log(`[BuildZip] event=${eventId} quality=${quality} claimed job ${job.id}`);
    yield* Effect.promise(() => notifyDownloadStatus(eventId, quality).catch(() => {}));

    const photos = yield* loadPhotos(eventId);
    console.log(`[BuildZip] event=${eventId} quality=${quality} loaded ${photos.length} photos`);
    yield* markBuilding(job.id, photos.length);
    yield* Effect.promise(() => notifyDownloadStatus(eventId, quality).catch(() => {}));

    // Retry only the S3 streaming part — claimJob must NOT be retried
    // because it atomically transitions QUEUED→BUILDING and a second
    // attempt would see BUILDING and return null (broken retry).
    // Each attempt restarts from scratch: streamZipPartsToS3 deletes any
    // parts left by the previous attempt before writing.
    const result = yield* streamZipPartsToS3(eventId, quality, photos, job.id).pipe(
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

    // A photo deleted DURING this build was not in the snapshot's delete sweep —
    // its entries were not committed yet, so there was nothing for it to expire —
    // but it may well have been zipped into a part this build just committed.
    // Reclaim those parts through the ordinary deletion path before anyone is
    // told the archive is ready. Runs on the cancelled/superseded path too: those
    // leave their already-committed parts behind, deleted photos and all.
    yield* Effect.promise(() => expirePartsForMissingPhotos(eventId).catch(() => 0));

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
      `[BuildZip] event=${eventId} quality=${quality} marked READY (parts=${result.partCount}, totalSize=${result.totalSizeBytes})`
    );
    yield* Effect.promise(() => notifyDownloadStatus(eventId, quality).catch(() => {}));

    // If more STALE parts appeared during this build (e.g. rebuildAll or a
    // deletion arrived mid-build), run another pass so they don't get stuck.
    yield* Effect.promise(async () => {
      const remainingStale = await prisma.downloadArchivePart.count({
        where: { jobId: job.id, status: "STALE" },
      });
      if (remainingStale > 0) {
        await prisma.downloadJob.updateMany({
          where: { eventId, quality, status: "READY" },
          data: { status: "QUEUED", queuedAt: new Date(), processedPhotos: 0 },
        });
        console.log(`[BuildZip] event=${eventId} quality=${quality} ${remainingStale} STALE part(s) remain, re-queued`);
        await notifyDownloadStatus(eventId, quality).catch(() => {});
      }
    });
  }).pipe(
    Effect.catchAll((e) =>
      Effect.gen(function* () {
        yield* Console.error(`ZIP build failed for event ${eventId} quality ${quality}: ${e}`);
        const job = yield* Effect.tryPromise({
          try: () => prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) }),
          catch: () => null,
        });
        if (job && job.status !== "CANCELLED") {
          yield* markFailed(job.id, String(e));
          yield* Effect.promise(() => notifyDownloadStatus(eventId, quality).catch(() => {}));
        }
      })
    )
  );

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

const claimJob = (eventId: string, quality: Quality) =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await prisma.downloadJob.update({
          where: { eventId_quality: { eventId, quality }, status: "QUEUED" },
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
          // Starts the idle clock, so an archive nobody ever downloads still
          // has a COALESCE(lastDownloadedAt, readyAt) for the expiry decision.
          readyAt: new Date(),
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
const streamZipPartsToS3 = (
  eventId: string,
  quality: Quality,
  photos: Photo[],
  jobId: string
) =>
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

    // Byte size of one photo entry. ORIGINAL uses the stored original size
    // (HEAD-probing only legacy rows that lack it); DISPLAY has no stored size,
    // so it HEAD-probes the display object.
    const entryBytesOf = (photo: Photo) =>
      Effect.tryPromise({
        try: async () => {
          let size: number | null | undefined =
            quality === "DISPLAY" ? undefined : photo.sizeBytes;
          if (size === null || size === undefined) {
            const head = await s3.send(
              new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: sourceKey(photo, quality) })
            );
            size = head.ContentLength ?? 0;
          }
          return zipEntryBytes(size, entryName(photo).length);
        },
        catch: (e) => new Error(`Head object failed for ${sourceKey(photo, quality)}: ${e}`),
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

    // ---- Work A: parts to rebuild from stored membership -----------------
    // STALE: a photo inside it was deleted (or the admin forced a rebuild).
    // EXPIRED: its bytes were reclaimed by the idle reaper — the membership is
    // exactly what survived for this moment, so rebuild it in place (same
    // partIndex, same membershipSig, generation + 1).
    const staleParts = existingParts.filter((p) => p.status === "STALE" || p.status === "EXPIRED");

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
            new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: sourceKey(photo, quality) })
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
        const key = s3Keys.zipPart(eventId, quality, part.partIndex, newGen);
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
        const key = s3Keys.zipPart(eventId, quality, w.partIndex, gen);
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
    // Scoped to THIS variant's objects so a DISPLAY build never deletes the
    // ORIGINAL variant's parts (both share the {eventId}/archive/ prefix).
    yield* Effect.promise(async () => {
      const live = await prisma.downloadArchivePart.findMany({ where: { jobId }, select: { key: true } });
      const liveKeys = new Set(live.map((p) => p.key).filter(Boolean));
      const listed = await listS3Prefix(s3Keys.archivePrefix(eventId)).catch(() => [] as string[]);
      const orphans = listed.filter(
        (k) => s3Keys.archiveKeyQuality(eventId, k) === quality && !liveKeys.has(k)
      );
      for (const k of orphans) await deleteS3Object(k).catch(() => {});
      if (orphans.length) console.log(`[ZIP ${eventId}] quality=${quality} swept ${orphans.length} orphan archive object(s)`);
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
