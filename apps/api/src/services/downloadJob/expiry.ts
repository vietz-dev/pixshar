// Idle-expiry of download archives (PIXSHAR-1).
//
// An archive that hasn't been downloaded in DOWNLOAD_ARCHIVE_TTL_DAYS is
// disposable — its ZIP bytes get deleted from S3 while the DownloadJob +
// DownloadArchivePart rows (the membership) stay, so a later request can
// rebuild the same parts with the same partIndex + membershipSig.
//
// This module holds the *pure decision*. It must stay free of DB/S3/env imports
// so it can be unit-tested without a running stack — the effect that acts on it
// (expireArchive) and the periodic reaper live in reaper.ts.
import type { DownloadJobStatus } from "@prisma/client";

// Structurally satisfied by a DownloadJob row; kept minimal so the decision
// stays testable without a database.
export type ExpiryCandidate = {
  status: DownloadJobStatus;
  lastDownloadedAt: Date | null;
  readyAt: Date | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When will this archive's bytes be reclaimed if nobody downloads it? `null`
 * means never: expiry is disabled (`ttlDays = 0`, the permanent-archive
 * behaviour), the job holds no bytes to reclaim (only a READY job does), or its
 * idle clock never started.
 *
 * The idle clock starts at the last download and falls back to the build
 * (`readyAt`) for an archive nobody ever downloaded.
 *
 * This is THE definition of the TTL clock: `isExpired` is derived from it, and
 * the admin panel's remaining-lifetime countdown reads it (payload.ts). Neither
 * may re-derive the arithmetic, or the reaper and the countdown could disagree.
 * `ttlDays` stays a parameter so this module needs no env import.
 */
export function archiveExpiresAt(job: ExpiryCandidate, ttlDays: number): Date | null {
  if (ttlDays <= 0) return null;
  if (job.status !== "READY") return null;
  const idleSince = job.lastDownloadedAt ?? job.readyAt;
  if (!idleSince) return null;
  return new Date(idleSince.getTime() + ttlDays * DAY_MS);
}

/**
 * Is this archive idle past its TTL and therefore reclaimable?
 *
 * The boundary is strict: idle for *exactly* the TTL is not yet expired.
 */
export function isExpired(job: ExpiryCandidate, now: Date, ttlDays: number): boolean {
  const expiresAt = archiveExpiresAt(job, ttlDays);
  return expiresAt !== null && now.getTime() > expiresAt.getTime();
}
