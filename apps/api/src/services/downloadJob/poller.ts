import { prisma } from "../../lib/prisma.js";
import { env } from "../../lib/env.js";
import { notifyDownloadStatus } from "./status.js";
import { runBuildZip } from "./builder.js";

// ---------------------------------------------------------------------------
// 2. Debounce poller — background loop
// ---------------------------------------------------------------------------

let pollerRunning = false;

export function startDebouncePoller(): void {
  if (pollerRunning) return;
  pollerRunning = true;
  console.log(`[Poller] starting (interval=15s)`);
  setInterval(() => {
    checkDebounceTimers().catch(() => {});
  }, 15_000);
}

async function checkDebounceTimers(): Promise<void> {
  const now = new Date();
  const maxWaitCutoff = new Date(now.getTime() - env.DOWNLOAD_MAX_WAIT_SECONDS * 1000);

  // Build when quiet period elapsed OR max-wait ceiling hit (so a
  // continuous stream of uploads can't starve the archive indefinitely).
  const ready = await prisma.downloadJob.findMany({
    where: {
      status: "DEBOUNCING",
      OR: [
        { debounceUntil: { lte: now } },
        { debounceStartedAt: { lte: maxWaitCutoff } },
      ],
    },
    orderBy: { debounceStartedAt: "asc" },
  });

  for (const job of ready) {
    // Count-checked transition so two replicas can't both launch the build.
    const res = await prisma.downloadJob.updateMany({
      where: { id: job.id, status: "DEBOUNCING" },
      data: { status: "QUEUED", queuedAt: new Date(), processedPhotos: 0 },
    });
    if (res.count !== 1) continue;
    console.log(`[Poller] queuing build for event=${job.eventId} quality=${job.quality}`);
    notifyDownloadStatus(job.eventId, job.quality).catch(() => {});
  }

  // Enqueue all QUEUED jobs (incl. build-now / rebuild-all ones, which bypass DEBOUNCING)
  // into the per-process serial build queue, oldest first. runBuildZip
  // atomically claims QUEUED→BUILDING so concurrent worker replicas stay safe.
  const queued = await prisma.downloadJob.findMany({
    where: { status: "QUEUED" },
    orderBy: [{ queuedAt: "asc" }, { createdAt: "asc" }],
  });
  for (const job of queued) {
    runBuildZip(job.eventId, job.quality);
  }
}

// ---------------------------------------------------------------------------
// 2b. Stale-BUILDING reaper — recover a build a crashed pod left mid-flight.
// ---------------------------------------------------------------------------

export async function reapStaleBuilding(): Promise<number> {
  const cutoff = new Date(Date.now() - env.DOWNLOAD_BUILD_LEASE_SECONDS * 1000);
  // queuedAt is intentionally left untouched: a crashed build keeps its place
  // at the front of the FIFO queue.
  const res = await prisma.downloadJob.updateMany({
    where: {
      status: "BUILDING",
      OR: [
        { heartbeatAt: { lt: cutoff } },
        { heartbeatAt: null, updatedAt: { lt: cutoff } }, // legacy/never-heartbeated rows
      ],
    },
    data: { status: "QUEUED", processedPhotos: 0 },
  });
  if (res.count > 0) console.log(`[ZipReaper] requeued ${res.count} stale BUILDING job(s)`);
  return res.count;
}

let zipReaperRunning = false;

export function startZipReaper(): void {
  if (zipReaperRunning) return;
  zipReaperRunning = true;
  reapStaleBuilding().catch(() => {}); // startup sweep
  setInterval(
    () => reapStaleBuilding().catch(() => {}),
    (env.DOWNLOAD_BUILD_LEASE_SECONDS * 1000) / 2
  );
}
