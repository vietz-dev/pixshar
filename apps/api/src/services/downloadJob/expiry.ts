// Idle-expiry of download archives (PIXSHAR-1).
//
// An archive that hasn't been downloaded in DOWNLOAD_ARCHIVE_TTL_DAYS is
// disposable — its ZIP bytes get deleted from S3 while the DownloadJob +
// DownloadArchivePart rows (the membership) stay, so a later request can
// rebuild the same parts with the same partIndex + membershipSig.
//
// This module holds the *pure decision*. The effectful reaper / release path
// (ticket 3) lands here too and calls isExpired.
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
 * Is this archive idle past its TTL and therefore reclaimable?
 *
 * The idle clock starts at the last download and falls back to the build
 * (`readyAt`) for an archive nobody ever downloaded. `ttlDays = 0` disables
 * expiry entirely, preserving the permanent-archive behaviour. Only a READY job
 * holds ZIP bytes on S3, so only a READY job can expire.
 *
 * The boundary is strict: idle for *exactly* the TTL is not yet expired.
 */
export function isExpired(job: ExpiryCandidate, now: Date, ttlDays: number): boolean {
  if (ttlDays <= 0) return false;
  if (job.status !== "READY") return false;
  const idleSince = job.lastDownloadedAt ?? job.readyAt;
  if (!idleSince) return false;
  return now.getTime() - idleSince.getTime() > ttlDays * DAY_MS;
}
