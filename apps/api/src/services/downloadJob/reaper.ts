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
 * ROWS FIRST, THEN OBJECTS — the same rule deletion.ts follows:
 *
 *  1. In ONE transaction: CAS-claim the job READY → EXPIRED
 *     (`updateMany WHERE status = 'READY'`, so Postgres picks the single winner
 *     among concurrent sweeps) AND flip every part row to EXPIRED. The keys are
 *     read inside the same transaction, before the flip, because that is what
 *     tells us which objects were live.
 *  2. Only then delete the objects.
 *
 * The invariant this buys: a part row is never READY while its object is gone.
 * Every crash point (and an S3 delete that exhausts its retries) leaves EXPIRED
 * rows whose objects may still exist — the harmless direction: nothing is
 * served from them (both the payload and the redirect endpoint gate on the
 * row), the builder's work list picks EXPIRED parts up and regenerates them at
 * generation + 1, and its orphan sweep reclaims the leftover bytes. The reverse
 * order (delete, then flip) risks the state PIXSHAR-4 forbids: a READY job
 * whose READY parts point at deleted objects, which the builder would never
 * rebuild and a guest would be 302'd straight into a NoSuchKey.
 */
export const expireArchive = (job: ExpirableJob) =>
  Effect.gen(function* () {
    const claim = yield* claimForExpiry(job.id);
    if (!claim) return false; // another replica got there first

    let freedBytes = 0;
    if (claim.keys.length > 0) {
      const deleted = yield* Effect.tryPromise({
        try: () => deleteS3Objects(claim.keys),
        catch: (e) => new Error(`Archive object delete failed: ${e}`),
      }).pipe(
        Effect.retry({ times: 3, schedule: Schedule.exponential("500 millis") }),
        Effect.as(true),
        // The rows are already EXPIRED, so the archive IS expired whatever S3
        // says — the bytes are simply reclaimed later, by the rebuild's orphan
        // sweep. Failing here instead would leave the job counted as expired
        // and never retried (the sweep only looks at READY jobs).
        Effect.catchAll((e) =>
          Effect.sync(() => {
            console.error(
              `[ArchiveReaper] event=${job.eventId} quality=${job.quality} object delete failed: ${e}`
            );
            return false;
          })
        )
      );
      if (deleted) freedBytes = claim.freedBytes;
    }

    archiveExpiredTotal.inc({ quality: job.quality });
    if (freedBytes > 0) archiveBytesReclaimedTotal.inc({ quality: job.quality }, freedBytes);
    console.log(
      `[ArchiveReaper] expired event=${job.eventId} quality=${job.quality} parts=${claim.keys.length} freed=${freedBytes}B`
    );
    yield* Effect.promise(() => notifyDownloadStatus(job.eventId, job.quality).catch(() => {}));
    return true;
  });

// The claim: job CAS + part rows, atomically. Returns the objects that were
// live at that instant (null when another caller won the CAS), which is the
// only moment at which they can be read — after the flip every row says EXPIRED.
const claimForExpiry = (jobId: string) =>
  Effect.tryPromise({
    try: () =>
      prisma.$transaction(async (tx) => {
        const res = await tx.downloadJob.updateMany({
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
        if (res.count !== 1) return null;

        const live = await tx.downloadArchivePart.findMany({
          where: { jobId, status: { not: "EXPIRED" } },
          select: { key: true, sizeBytes: true },
        });
        await tx.downloadArchivePart.updateMany({
          where: { jobId },
          data: { status: "EXPIRED" },
        });

        return {
          keys: live.map((p) => p.key).filter((k): k is string => Boolean(k)),
          freedBytes: live.reduce((sum, p) => sum + Number(p.sizeBytes), 0),
        };
      }),
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
          // Only the claim transaction can fail here (a failed object delete is
          // handled inside expireArchive). It is all-or-nothing, so the job is
          // still READY and the next sweep simply tries again.
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
