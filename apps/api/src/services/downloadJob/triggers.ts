import { prisma } from "../../lib/prisma.js";
import { env } from "../../lib/env.js";
import { DEFAULT_QUALITY, ALL_QUALITIES, jobWhere, notifyDownloadStatus, type Quality } from "./status.js";

// ---------------------------------------------------------------------------
// 1. Debounce trigger — called after every successful photo processing
// ---------------------------------------------------------------------------

// Ensure a (event, variant) job row exists in a build-scheduled state. Used for
// lazy creation of the DISPLAY variant for events that predate it: the first
// guest download request (or the next photo activity) materializes the job so a
// worker picks it up — no mass backfill. If the job already exists this is a
// no-op that leaves its current state untouched.
export async function ensureJob(
  eventId: string,
  quality: Quality
): Promise<void> {
  const existing = await prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) });
  if (existing) return;
  const now = Date.now();
  try {
    await prisma.downloadJob.create({
      data: {
        eventId,
        quality,
        status: "DEBOUNCING",
        debounceUntil: new Date(now + env.DOWNLOAD_DEBOUNCE_SECONDS * 1000),
        debounceStartedAt: new Date(now),
      },
    });
    console.log(`[EnsureJob] event=${eventId} quality=${quality} created DEBOUNCING job`);
    notifyDownloadStatus(eventId, quality).catch(() => {});
  } catch {
    // Lost a race to a concurrent creator (unique constraint) — fine, it exists.
  }
}

export async function triggerDebounce(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<void> {
  const now = Date.now();
  const debounceUntil = new Date(now + env.DOWNLOAD_DEBOUNCE_SECONDS * 1000);
  const debounceStartedAt = new Date(now);
  console.log(`[Debounce] event=${eventId} quality=${quality} debounceUntil=${debounceUntil.toISOString()}`);

  await prisma.$transaction(async (tx) => {
    // Increment processed photo count once per photo — only on the canonical
    // ORIGINAL trigger so the fan-out to DISPLAY doesn't double-count.
    if (quality === DEFAULT_QUALITY) {
      await tx.event.update({
        where: { id: eventId },
        data: { processedPhotoCount: { increment: 1 } },
      });
    }

    // Upsert DownloadJob with state-machine transitions. `debounceStartedAt` is
    // set only when *entering* DEBOUNCING (never on extend) so checkDebounceTimers
    // can enforce a max-wait ceiling and the zip still builds during bulk uploads.
    const existing = await tx.downloadJob.findUnique({
      where: jobWhere(eventId, quality),
    });

    if (!existing) {
      await tx.downloadJob.create({
        data: { eventId, quality, status: "DEBOUNCING", debounceUntil, debounceStartedAt },
      });
      console.log(`[Debounce] event=${eventId} quality=${quality} created new DEBOUNCING job`);
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
        // Incremental model: existing parts are immutable and stay downloadable.
        // We only re-enter DEBOUNCING to schedule a reconcile that appends the
        // newly-arrived photos as NEW parts — never wipe what's already built.
        await tx.downloadJob.update({
          where: { id: existing.id },
          data: { status: "DEBOUNCING", debounceUntil, debounceStartedAt, processedPhotos: 0 },
        });
        console.log(`[Debounce] event=${eventId} READY -> DEBOUNCING (append pending)`);
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

  notifyDownloadStatus(eventId, quality).catch(() => {});
}

// Fan-out trigger: a photo upload feeds BOTH variants' jobs. Called by the image
// processor after a photo lands, so late uploads eventually appear in Kompakt
// and Original alike.
export async function triggerDebounceAllVariants(eventId: string): Promise<void> {
  for (const q of ALL_QUALITIES) {
    await triggerDebounce(eventId, q).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 1b. Reconcile trigger — schedule a build after a deletion or an admin action
// ---------------------------------------------------------------------------

// Unlike triggerDebounce this does NOT bump the processed-photo counter; it just
// schedules a (re)build. `immediate` skips the quiet window (admin "build now" /
// "rebuild all"); otherwise it debounces so bursts of deletions batch.
// Always routes through QUEUED/DEBOUNCING → the FIFO build queue, never a direct
// synchronous build, so worker/image-processor load stays bounded.
export async function triggerReconcile(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY,
  opts: { immediate?: boolean } = {}
): Promise<void> {
  const now = Date.now();
  const job = await prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) });
  if (!job) return; // no archive/job for this variant — nothing to reconcile

  if (job.status === "BUILDING") {
    // Don't disturb the in-flight build. Any parts marked STALE by the caller are
    // picked up by the post-build re-queue check (see buildZip).
    console.log(`[Reconcile] event=${eventId} quality=${quality} BUILDING in progress, will re-queue after`);
    notifyDownloadStatus(eventId, quality).catch(() => {});
    return;
  }

  if (opts.immediate) {
    await prisma.downloadJob.updateMany({
      where: { eventId, quality, status: { not: "BUILDING" } },
      data: { status: "QUEUED", queuedAt: new Date(now), debounceUntil: null, failureReason: null, processedPhotos: 0 },
    });
    console.log(`[Reconcile] event=${eventId} quality=${quality} queued immediately (was ${job.status})`);
  } else {
    await prisma.downloadJob.updateMany({
      where: { eventId, quality, status: { not: "BUILDING" } },
      data: {
        status: "DEBOUNCING",
        debounceUntil: new Date(now + env.DOWNLOAD_DEBOUNCE_SECONDS * 1000),
        debounceStartedAt: new Date(now),
        queuedAt: null,
        failureReason: null,
        processedPhotos: 0,
      },
    });
    console.log(`[Reconcile] event=${eventId} quality=${quality} debouncing (was ${job.status})`);
  }
  notifyDownloadStatus(eventId, quality).catch(() => {});
}

// Fan-out reconcile: after a photo deletion the affected parts of BOTH variants
// were marked STALE, so schedule a rebuild for each.
export async function triggerReconcileAllVariants(
  eventId: string,
  opts: { immediate?: boolean } = {}
): Promise<void> {
  for (const q of ALL_QUALITIES) {
    await triggerReconcile(eventId, q, opts).catch(() => {});
  }
}
