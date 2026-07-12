// The idle reaper — the effect side of archive expiry (PIXSHAR-4).
//
// Split from expiry.ts on purpose: expiry.ts holds the pure decision and must
// stay importable without a database, an S3 client or a parsed env. Everything
// that actually touches the world lives here.
import { Effect, Schedule } from "effect";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../lib/env.js";
import { deleteS3Objects } from "../../lib/s3.js";
import { archiveExpiredTotal, archiveBytesReclaimedTotal } from "../../lib/metrics.js";
import { DEFAULT_QUALITY, jobWhere, notifyDownloadStatus, type Quality } from "./status.js";
import { isExpired } from "./expiry.js";

// ---------------------------------------------------------------------------
// The effect: reclaim one archive's bytes
// ---------------------------------------------------------------------------

// Minimal identity of the archive to reclaim — structurally satisfied by a
// DownloadJob row, so both the reaper's query and the admin release path pass
// their row straight in.
export type ExpirableJob = {
  id: string;
  eventId: string;
  quality: Quality;
};

/**
 * Reclaim the S3 objects of one (event, variant) archive, keeping its
 * membership: the DownloadArchivePart rows and their DownloadArchivePartEntry
 * children survive, so the next build reproduces every part with the same
 * partIndex and the same membershipSig and a guest's per-part "downloaded"
 * ticks stay valid. Returns false when another replica (or an earlier call)
 * already claimed the job.
 *
 * The order of the three steps is the correctness rule:
 *
 *  1. CAS-claim the job READY → EXPIRED (`updateMany WHERE status = 'READY'`).
 *     Postgres decides the winner, so two concurrent sweeps expire the archive
 *     exactly once and only the winner deletes anything. From this moment the
 *     job is never again a READY job pointing at objects we are about to
 *     delete, and the payload/redirect endpoints stop offering its parts (they
 *     gate on the job being EXPIRED, not just on the part rows).
 *  2. Delete the objects.
 *  3. Only then flip the part rows to EXPIRED.
 *
 * A crash between 2 and 3 leaves an EXPIRED job whose parts still carry their
 * (now dead) keys — harmless: nothing is offered to a guest, and the next
 * rebuild overwrites them at generation + 1. The reverse order would risk the
 * opposite, and worse, state: parts still advertised while their bytes are
 * already gone.
 */
export const expireArchive = (job: ExpirableJob) =>
  Effect.gen(function* () {
    const claimed = yield* claimForExpiry(job.id);
    if (!claimed) return false; // another replica got there first

    const parts = yield* Effect.tryPromise({
      try: () =>
        prisma.downloadArchivePart.findMany({
          where: { jobId: job.id },
          select: { key: true, sizeBytes: true, status: true },
        }),
      catch: (e) => new Error(`Load parts for expiry failed: ${e}`),
    });

    const live = parts.filter((p) => p.key && p.status !== "EXPIRED");
    const keys = live.map((p) => p.key);
    const freedBytes = live.reduce((sum, p) => sum + Number(p.sizeBytes), 0);

    if (keys.length > 0) {
      yield* Effect.tryPromise({
        try: () => deleteS3Objects(keys),
        catch: (e) => new Error(`Archive object delete failed: ${e}`),
      }).pipe(Effect.retry({ times: 3, schedule: Schedule.exponential("500 millis") }));
    }

    yield* Effect.tryPromise({
      try: () =>
        prisma.downloadArchivePart.updateMany({
          where: { jobId: job.id },
          data: { status: "EXPIRED" },
        }),
      catch: (e) => new Error(`Mark parts expired failed: ${e}`),
    });

    archiveExpiredTotal.inc({ quality: job.quality });
    if (freedBytes > 0) archiveBytesReclaimedTotal.inc({ quality: job.quality }, freedBytes);
    console.log(
      `[ArchiveReaper] expired event=${job.eventId} quality=${job.quality} parts=${keys.length} freed=${freedBytes}B`
    );
    yield* Effect.promise(() => notifyDownloadStatus(job.eventId, job.quality).catch(() => {}));
    return true;
  });

// The claim. Count-checked so exactly one caller may proceed to the delete.
const claimForExpiry = (jobId: string) =>
  Effect.tryPromise({
    try: async () => {
      const res = await prisma.downloadJob.updateMany({
        where: { id: jobId, status: "READY" },
        data: {
          status: "EXPIRED",
          expiredAt: new Date(),
          expiryCount: { increment: 1 },
          // The idle clock of the *next* incarnation must start at its own
          // readyAt. Keeping a download date that predates the expiry would
          // make the reaper expire the rebuilt archive on its very next sweep.
          lastDownloadedAt: null,
        },
      });
      return res.count === 1;
    },
    catch: (e) => new Error(`Expiry claim failed: ${e}`),
  });

/**
 * Admin "release archive" — the same reclamation the reaper performs, on
 * demand. A no-op (false) when the variant holds no bytes to reclaim, so
 * clicking it twice is harmless.
 */
export async function releaseArchive(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<boolean> {
  const job = await prisma.downloadJob.findUnique({
    where: jobWhere(eventId, quality),
    select: { id: true, eventId: true, quality: true, status: true },
  });
  if (!job || job.status !== "READY") return false; // advisory — the CAS claim decides
  return Effect.runPromise(expireArchive(job));
}

// ---------------------------------------------------------------------------
// The periodic sweep
// ---------------------------------------------------------------------------

/**
 * One reaper pass: every READY archive whose idle clock ran out loses its bytes.
 * Deliberately application-side rather than an S3 lifecycle rule — lifecycle
 * expiry is age-based and would delete an archive that is downloaded daily.
 */
export async function sweepExpiredArchives(): Promise<number> {
  const ttlDays = env.DOWNLOAD_ARCHIVE_TTL_DAYS;
  if (ttlDays <= 0) return 0; // expiry disabled — archives live forever

  const now = new Date();
  const candidates = await prisma.downloadJob.findMany({
    where: { status: "READY" },
    select: {
      id: true,
      eventId: true,
      quality: true,
      status: true,
      lastDownloadedAt: true,
      readyAt: true,
    },
  });

  let expired = 0;
  for (const job of candidates) {
    if (!isExpired(job, now, ttlDays)) continue;
    const done = await Effect.runPromise(
      expireArchive(job).pipe(
        Effect.catchAll((e) => {
          // The job is already EXPIRED (the claim landed); its objects are not.
          // Nothing is served from them, and the next rebuild replaces them.
          console.error(
            `[ArchiveReaper] expire failed event=${job.eventId} quality=${job.quality}: ${e}`
          );
          return Effect.succeed(false);
        })
      )
    );
    if (done) expired += 1;
  }
  if (expired > 0) console.log(`[ArchiveReaper] expired ${expired} idle archive(s)`);
  return expired;
}

let expiryReaperRunning = false;

export function startExpiryReaper(): void {
  if (expiryReaperRunning) return;
  if (env.DOWNLOAD_ARCHIVE_TTL_DAYS <= 0) {
    console.log("[ArchiveReaper] disabled (DOWNLOAD_ARCHIVE_TTL_DAYS=0)");
    return; // never sweeps, not even once
  }
  expiryReaperRunning = true;
  console.log(
    `[ArchiveReaper] starting (ttl=${env.DOWNLOAD_ARCHIVE_TTL_DAYS}d, sweep=${env.DOWNLOAD_ARCHIVE_SWEEP_SECONDS}s)`
  );
  sweepExpiredArchives().catch(() => {}); // startup sweep
  setInterval(
    () => sweepExpiredArchives().catch(() => {}),
    env.DOWNLOAD_ARCHIVE_SWEEP_SECONDS * 1000
  );
}
