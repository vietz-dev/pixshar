import { prisma } from "../../lib/prisma.js";
import { archiveBuildsTotal } from "../../lib/metrics.js";
import { DEFAULT_QUALITY, jobWhere, notifyDownloadStatus, statusMessage, type Quality } from "./status.js";
import { requestBuild, triggerReconcile } from "./triggers.js";
import { getDownloadJobStatus } from "./payload.js";

// ---------------------------------------------------------------------------
// 3. Manual controls (admin)
// ---------------------------------------------------------------------------

// Admin "build now": skip the quiet debounce window and queue the pending
// reconcile immediately. Only the *timer* is skipped — the build still goes
// through QUEUED → FIFO claim, so it never bypasses the worker/image-processor
// load management.
//
// Pre-warm (PIXSHAR-8): this is also the ONE button that must work when there
// is nothing to accelerate yet — no job at all (NONE), or a job whose bytes
// the idle reaper reclaimed (EXPIRED) — so the photographer can have an
// archive ready before sharing the link with a crowd. Both route through
// requestBuild, the single entry point that creates/re-queues a build, so
// there is exactly one queueing path (never a second one here).
export async function buildNow(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<void> {
  const job = await prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) });

  if (!job || job.status === "EXPIRED" || job.status === "FAILED" || job.status === "CANCELLED") {
    await requestBuild(eventId, quality, "admin");
    return;
  }

  if (job.status === "DEBOUNCING") {
    // Same build cycle, only the quiet timer skipped — it was counted when the
    // cycle was scheduled, so no second build counter here.
    await prisma.downloadJob.updateMany({
      where: { eventId, quality, status: "DEBOUNCING" },
      data: { status: "QUEUED", queuedAt: new Date(), debounceUntil: null, failureReason: null, processedPhotos: 0 },
    });
    console.log(`[BuildNow] event=${eventId} quality=${quality} DEBOUNCING -> QUEUED`);
    notifyDownloadStatus(eventId, quality).catch(() => {});
  } else {
    // QUEUED / BUILDING / READY: already queued, or nothing new to build.
    console.log(`[BuildNow] event=${eventId} quality=${quality} no-op (status=${job.status})`);
  }
}

// Admin "rebuild all": regenerate every existing part's ZIP bytes. Marks the
// parts that still HOLD bytes STALE so the reconcile rebuilds each one FROM ITS
// STORED MEMBERSHIP (never re-planning across parts), then queues immediately.
// Membership is preserved, so a guest who already downloaded a part is not
// forced to re-download it unless a photo was deleted from that exact part.
export async function rebuildAll(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<void> {
  const job = await prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) });

  // Nothing built (NONE), or the bytes are already gone (EXPIRED — the idle
  // reaper or an admin release reclaimed them): there is nothing to invalidate,
  // the parts already sit in the one state that means "regenerate me". Route
  // through requestBuild, the single entry point that creates/re-queues a build,
  // so rebuildCount and the expiry→rebuild histogram move — queueing here
  // ourselves bypassed them entirely.
  if (!job || job.status === "EXPIRED") {
    await requestBuild(eventId, quality, "admin");
    return;
  }

  // STALE means "the OLD object keeps serving while a new one is built", so it
  // is only ever a valid state for a part that still has an object: partHasObject
  // gates on `key && status !== "EXPIRED"`, and would happily hand a guest a URL
  // to bytes the reaper already deleted if an EXPIRED part were flipped to STALE.
  // An EXPIRED part needs no marking — the builder's work list already picks it
  // up alongside the STALE ones and rebuilds it at generation + 1.
  await prisma.downloadArchivePart.updateMany({
    where: { jobId: job.id, status: { not: "EXPIRED" } },
    data: { status: "STALE" },
  });
  archiveBuildsTotal.inc({ quality, trigger: "admin" });
  console.log(`[RebuildAll] event=${eventId} quality=${quality} marked object-holding parts STALE`);
  await triggerReconcile(eventId, quality, { immediate: true });
}

// Cancel an in-flight/pending build. Incremental model: already-committed parts
// are immutable and stay downloadable, so cancel does NOT delete the archive —
// it just stops adding new/updated parts. A STALE part reverts to READY (its old
// object is still valid) so it isn't stuck showing "updating".
export async function cancelJob(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<void> {
  const job = await prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) });
  if (!job) return;

  if (job.status !== "BUILDING" && job.status !== "QUEUED" && job.status !== "DEBOUNCING") {
    return; // nothing to cancel
  }

  await prisma.downloadJob.update({
    where: { id: job.id },
    data: { status: "CANCELLED", processedPhotos: 0, failureReason: "Cancelled by admin" },
  });
  // Revert any pending rebuilds — the old object is still present, so it keeps
  // being served. This relies on the invariant every reclaim path upholds
  // (rows first, then objects): a part whose object is gone is EXPIRED, never
  // STALE. Reverting an object-less part to READY here would be exactly the
  // state PIXSHAR-4 forbids — a READY part 302'ing a guest into a NoSuchKey —
  // so the filter is on the status, not on the key (which is never null).
  await prisma.downloadArchivePart.updateMany({
    where: { jobId: job.id, status: "STALE" },
    data: { status: "READY" },
  });
  notifyDownloadStatus(eventId, quality).catch(() => {});
}

// ---------------------------------------------------------------------------
// 3a. The admin-facing status shape (PIXSHAR-8)
// ---------------------------------------------------------------------------

export interface AdminDownloadStatus {
  quality: Quality;
  status: string;
  message: string;
  photoCount: number;
  processedPhotos: number;
  uploadProgress: number;
  totalPhotos: number;
  totalSizeBytes: number;
  partCount: number;
  debounceUntil: string | null;
  failureReason: string | null;
  // Idle-clock provenance and the derived countdown ("läuft in 3 Tagen ab,
  // wenn niemand lädt") — null when the archive doesn't hold bytes (not READY)
  // or expiry is disabled (DOWNLOAD_ARCHIVE_TTL_DAYS=0).
  lastDownloadedAt: string | null;
  readyAt: string | null;
  expiredAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
}

/**
 * The one admin status shape, shared by GET .../download/status and its SSE
 * stream so both surfaces gain the EXPIRED state and the remaining-lifetime
 * fields by construction rather than by keeping two hand-rolled objects in
 * sync. Built on getDownloadJobStatus (payload.ts), which already derives the
 * honest part count/size and the expiresAt countdown.
 */
export async function buildAdminDownloadStatus(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<AdminDownloadStatus> {
  const [job, totalPhotos] = await Promise.all([
    getDownloadJobStatus(eventId, quality),
    prisma.photo.count({ where: { eventId, status: "PROCESSED" } }),
  ]);

  if (!job) {
    return {
      quality,
      status: "NONE",
      message: statusMessage("NONE"),
      photoCount: 0,
      processedPhotos: 0,
      uploadProgress: 0,
      totalPhotos,
      totalSizeBytes: 0,
      partCount: 0,
      debounceUntil: null,
      failureReason: null,
      lastDownloadedAt: null,
      readyAt: null,
      expiredAt: null,
      expiresAt: null,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    quality: job.quality,
    status: job.status,
    message: statusMessage(job.status),
    photoCount: job.photoCount,
    processedPhotos: job.processedPhotos,
    uploadProgress: job.uploadProgress,
    totalPhotos,
    totalSizeBytes: job.totalSizeBytes,
    partCount: job.partCount,
    debounceUntil: job.debounceUntil ? job.debounceUntil.toISOString() : null,
    failureReason: job.failureReason,
    lastDownloadedAt: job.lastDownloadedAt ? job.lastDownloadedAt.toISOString() : null,
    readyAt: job.readyAt ? job.readyAt.toISOString() : null,
    expiredAt: job.expiredAt ? job.expiredAt.toISOString() : null,
    expiresAt: job.expiresAt ? job.expiresAt.toISOString() : null,
    updatedAt: job.updatedAt.toISOString(),
  };
}
