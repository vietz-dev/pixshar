import type { DownloadJobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../lib/env.js";
import { archiveBuildsTotal, archiveExpiryToRebuildSeconds } from "../../lib/metrics.js";
import { DEFAULT_QUALITY, ALL_QUALITIES, jobWhere, notifyDownloadStatus, type Quality } from "./status.js";

// ---------------------------------------------------------------------------
// 1. Debounce trigger — called after every successful photo processing
// ---------------------------------------------------------------------------

// An archive is *alive* when it currently holds ZIP bytes (READY) or is on its
// way to holding them. Governing rule of the lazy model: lazy to create, eager
// to keep current — only a live variant gets the append. A variant that never
// existed, or whose bytes the idle reaper reclaimed (EXPIRED), stays gone until
// someone explicitly asks for it; that is the whole cost saving.
const ALIVE_STATUSES: readonly DownloadJobStatus[] = ["READY", "DEBOUNCING", "QUEUED", "BUILDING"];

// States from which a build must NOT be scheduled again: one is already pending
// or the archive is current. Guarantees a guest hammering the request button
// cannot stack builds.
const BUILD_PENDING: readonly DownloadJobStatus[] = ["DEBOUNCING", "QUEUED", "BUILDING"];

export async function triggerDebounce(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<void> {
  const now = Date.now();
  const debounceUntil = new Date(now + env.DOWNLOAD_DEBOUNCE_SECONDS * 1000);
  const debounceStartedAt = new Date(now);
  console.log(`[Debounce] event=${eventId} quality=${quality} debounceUntil=${debounceUntil.toISOString()}`);

  await prisma.$transaction(async (tx) => {
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

// Fan-out trigger: a processed photo is appended to every variant that is ALIVE
// — never to one that is absent or EXPIRED. Called by the image processor after
// a photo lands.
//
// This is the "eager to keep current" half of the rule: an event whose guests
// are actively downloading keeps a complete archive, because the append goes
// through the ordinary debounce-and-reconcile path (the new photo becomes a new
// part; the existing parts are untouched). The "lazy to create" half is the
// gate below: an upload never resurrects an archive nobody asked for, so an
// event nobody downloads costs nothing but its photos.
export async function triggerDebounceAllVariants(eventId: string): Promise<void> {
  // The event's processed-photo counter tracks the event, not any archive, so it
  // is bumped even when no variant is alive to append to.
  await prisma.event
    .update({ where: { id: eventId }, data: { processedPhotoCount: { increment: 1 } } })
    .catch(() => {});

  for (const quality of ALL_QUALITIES) {
    const job = await prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) });
    if (!job || !ALIVE_STATUSES.includes(job.status)) {
      console.log(
        `[Debounce] event=${eventId} quality=${quality} not alive (${job?.status ?? "NONE"}) — no build`
      );
      continue;
    }
    // READY → DEBOUNCING starts a new build cycle; the other alive states are
    // already inside one, so counting them again would count one build twice.
    if (job.status === "READY") archiveBuildsTotal.inc({ quality, trigger: "append" });
    await triggerDebounce(eventId, quality).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 1a. Explicit build request — the only thing that CREATES an archive
// ---------------------------------------------------------------------------

// Who asked. `guest` requests are labelled by what the job needs (first build vs
// rebuild after expiry); an admin action is labelled as such whatever the state.
export type BuildSource = "guest" | "admin";

/**
 * Schedule a build of one (event, variant) archive on explicit demand, creating
 * the job if it does not exist. THE single entry point for materializing an
 * archive — the guest "request archive" endpoint and the admin pre-warm both go
 * through here, so the state machine and the metrics have exactly one home.
 *
 * NONE / EXPIRED / FAILED / CANCELLED → QUEUED.
 * READY / DEBOUNCING / QUEUED / BUILDING → no-op: the archive is current or a
 * build is already pending, so a guest hammering the button cannot stack builds
 * (the per-(event, variant) CAS claim in the builder is the second guarantee).
 *
 * One exception to the READY no-op: a photo deletion reclaims the objects of the
 * parts that contained the photo (PIXSHAR-6) and queues nothing, which leaves a
 * READY job that is only *partially* available. Such a job is not current, and
 * this — the next request — is what rebuilds those parts.
 *
 * Returns true only when this call actually scheduled a build.
 */
export async function requestBuild(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY,
  source: BuildSource = "guest"
): Promise<boolean> {
  const now = new Date();
  const job = await prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) });

  if (!job) {
    try {
      await prisma.downloadJob.create({
        data: { eventId, quality, status: "QUEUED", queuedAt: now },
      });
    } catch {
      // Lost the unique-constraint race to a concurrent request — it queued the
      // build, not us.
      return false;
    }
    archiveBuildsTotal.inc({ quality, trigger: source === "admin" ? "admin" : "first_build" });
    console.log(`[RequestBuild] event=${eventId} quality=${quality} created QUEUED job (${source})`);
    notifyDownloadStatus(eventId, quality).catch(() => {});
    return true;
  }

  if (BUILD_PENDING.includes(job.status)) {
    console.log(`[RequestBuild] event=${eventId} quality=${quality} no-op (status=${job.status})`);
    return false;
  }

  if (job.status === "READY") {
    // Complete = every part still holds its object. Only a deletion can leave a
    // READY job with EXPIRED (object-less) parts; those must be rebuilt.
    const missingParts = await prisma.downloadArchivePart.count({
      where: { jobId: job.id, status: "EXPIRED" },
    });
    if (missingParts === 0) {
      console.log(`[RequestBuild] event=${eventId} quality=${quality} no-op (status=READY)`);
      return false;
    }
    console.log(
      `[RequestBuild] event=${eventId} quality=${quality} READY but ${missingParts} part(s) reclaimed — rebuilding`
    );
  }

  // EXPIRED / FAILED / CANCELLED. The reconcile that follows rebuilds each
  // surviving part from its stored membership — same partIndex, same
  // membershipSig, generation + 1 — and appends whatever arrived while the
  // archive was gone as new parts. Nothing is re-planned, so a guest's per-part
  // "downloaded" ticks survive an expire/rebuild cycle.
  const wasExpired = job.status === "EXPIRED";
  const res = await prisma.downloadJob.updateMany({
    // CAS on the status we observed: two concurrent requests queue one build.
    where: { eventId, quality, status: job.status },
    data: {
      status: "QUEUED",
      queuedAt: now,
      debounceUntil: null,
      failureReason: null,
      processedPhotos: 0,
      ...(wasExpired ? { rebuildCount: { increment: 1 } } : {}),
    },
  });
  if (res.count !== 1) return false;

  const trigger =
    source === "admin" ? "admin"
    : job.readyAt ? "on_demand_rebuild" // it held bytes once — this is a rebuild
    : "first_build";
  archiveBuildsTotal.inc({ quality, trigger });
  if (wasExpired && job.expiredAt) {
    archiveExpiryToRebuildSeconds.observe(
      { quality },
      (now.getTime() - job.expiredAt.getTime()) / 1000
    );
  }
  console.log(`[RequestBuild] event=${eventId} quality=${quality} ${job.status} -> QUEUED (${trigger})`);
  notifyDownloadStatus(eventId, quality).catch(() => {});
  return true;
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
