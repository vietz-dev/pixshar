import { prisma } from "../../lib/prisma.js";
import { DEFAULT_QUALITY, jobWhere, notifyDownloadStatus, type Quality } from "./status.js";
import { triggerReconcile } from "./triggers.js";

// ---------------------------------------------------------------------------
// 3. Manual controls (admin)
// ---------------------------------------------------------------------------

// Admin "build now": skip the quiet debounce window and queue the pending
// reconcile immediately. Only the *timer* is skipped — the build still goes
// through QUEUED → FIFO claim, so it never bypasses the worker/image-processor
// load management. If nothing is pending (already READY with no new photos), it
// is a no-op.
export async function buildNow(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<void> {
  const job = await prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) });
  if (!job) return; // no job → no pending uploads to build

  if (job.status === "DEBOUNCING" || job.status === "FAILED" || job.status === "CANCELLED") {
    await prisma.downloadJob.updateMany({
      where: { eventId, quality, status: job.status },
      data: { status: "QUEUED", queuedAt: new Date(), debounceUntil: null, failureReason: null, processedPhotos: 0 },
    });
    console.log(`[BuildNow] event=${eventId} quality=${quality} ${job.status} -> QUEUED`);
    notifyDownloadStatus(eventId, quality).catch(() => {});
  } else {
    // QUEUED / BUILDING / READY: already queued or nothing new to build.
    console.log(`[BuildNow] event=${eventId} quality=${quality} no-op (status=${job.status})`);
  }
}

// Admin "rebuild all": regenerate every existing part's ZIP bytes. Marks all
// parts STALE so the reconcile rebuilds each one FROM ITS STORED MEMBERSHIP
// (never re-planning across parts), then queues immediately. Membership is
// preserved, so a guest who already downloaded a part is not forced to
// re-download it unless a photo was deleted from that exact part.
export async function rebuildAll(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<void> {
  const job = await prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) });
  if (!job) return;

  await prisma.downloadArchivePart.updateMany({
    where: { jobId: job.id },
    data: { status: "STALE" },
  });
  console.log(`[RebuildAll] event=${eventId} quality=${quality} marked all parts STALE`);
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
  // Revert any pending rebuilds — the old (still-present) object stays served.
  await prisma.downloadArchivePart.updateMany({
    where: { jobId: job.id, status: "STALE" },
    data: { status: "READY" },
  });
  notifyDownloadStatus(eventId, quality).catch(() => {});
}
