import {
  Registry,
  Gauge,
  Counter,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";
import { prisma } from "./prisma.js";

export const register = new Registry();

collectDefaultMetrics({ register, prefix: "pixshar_" });

// ---------------------------------------------------------------------------
// Gauges — lazy DB queries via collect(), run only at scrape time
// ---------------------------------------------------------------------------

export const eventsTotal = new Gauge({
  name: "pixshar_events_total",
  help: "Total number of hosted events",
  registers: [register],
  async collect() {
    this.set(await prisma.event.count());
  },
});

export const photosByStatus = new Gauge({
  name: "pixshar_photos_by_status",
  help: "Photo count by processing status",
  labelNames: ["status"] as const,
  registers: [register],
  async collect() {
    const rows = await prisma.photo.groupBy({
      by: ["status"],
      _count: { status: true },
    });
    this.reset();
    for (const row of rows) {
      this.set({ status: row.status }, row._count.status);
    }
  },
});

export const storageBytesTotal = new Gauge({
  name: "pixshar_storage_bytes_total",
  help: "Total bytes used by all photo variants (original + display + thumb) for processed photos",
  registers: [register],
  async collect() {
    const r = await prisma.photo.aggregate({
      where: { status: "PROCESSED" },
      _sum: { sizeBytes: true },
    });
    this.set(r._sum.sizeBytes ?? 0);
  },
});

export const resizeQueueInflight = new Gauge({
  name: "pixshar_resize_queue_inflight",
  help: "Number of photos currently being processed by this pod",
  registers: [register],
});

// Archive lifecycle (PIXSHAR-9). expiryCount/rebuildCount live on DownloadJob,
// not in process memory: expiry and rebuild are rare per-event events whose
// whole value is their history across weeks, and an in-process counter would
// reset on every pod restart/rollout — erasing exactly the history the
// operator is tuning DOWNLOAD_ARCHIVE_TTL_DAYS against. So these two gauges
// mirror the DB counters at scrape time, same pattern as photosByStatus:
// aggregate query inside collect(), reset() before set(). Restricted to
// DownloadJobs touched in the last 30 days so the `event` label cardinality is
// bounded by recent activity, not by every event ever hosted.
const RECENT_ARCHIVE_ACTIVITY_DAYS = 30;

export const archiveExpiries = new Gauge({
  name: "pixshar_archive_expiries",
  help: "Cumulative archive expiries per event and variant (mirrors DownloadJob.expiryCount)",
  labelNames: ["event", "quality"] as const,
  registers: [register],
  async collect() {
    const cutoff = new Date(Date.now() - RECENT_ARCHIVE_ACTIVITY_DAYS * 24 * 60 * 60 * 1000);
    const rows = await prisma.downloadJob.findMany({
      where: { updatedAt: { gte: cutoff } },
      select: { quality: true, expiryCount: true, event: { select: { slug: true } } },
    });
    this.reset();
    for (const row of rows) {
      this.set({ event: row.event.slug, quality: row.quality }, row.expiryCount);
    }
  },
});

export const archiveRebuilds = new Gauge({
  name: "pixshar_archive_rebuilds",
  help: "Cumulative archive rebuilds per event and variant (mirrors DownloadJob.rebuildCount)",
  labelNames: ["event", "quality"] as const,
  registers: [register],
  async collect() {
    const cutoff = new Date(Date.now() - RECENT_ARCHIVE_ACTIVITY_DAYS * 24 * 60 * 60 * 1000);
    const rows = await prisma.downloadJob.findMany({
      where: { updatedAt: { gte: cutoff } },
      select: { quality: true, rebuildCount: true, event: { select: { slug: true } } },
    });
    this.reset();
    for (const row of rows) {
      this.set({ event: row.event.slug, quality: row.quality }, row.rebuildCount);
    }
  },
});

export const archiveLiveBytes = new Gauge({
  name: "pixshar_archive_live_bytes",
  help: "Bytes currently held in S3 by READY archive parts, by variant — the savings curve",
  labelNames: ["quality"] as const,
  registers: [register],
  async collect() {
    const rows = await prisma.downloadArchivePart.findMany({
      where: { status: "READY" },
      select: { sizeBytes: true, job: { select: { quality: true } } },
    });
    const sums = new Map<string, number>();
    for (const row of rows) {
      sums.set(row.job.quality, (sums.get(row.job.quality) ?? 0) + Number(row.sizeBytes));
    }
    this.reset();
    for (const [quality, bytes] of sums) {
      this.set({ quality }, bytes);
    }
  },
});

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export const galleryUnlocksTotal = new Counter({
  name: "pixshar_gallery_unlocks_total",
  help: "Gallery password unlock attempts",
  labelNames: ["result"] as const,
  registers: [register],
});

export const photoDownloadsTotal = new Counter({
  name: "pixshar_photo_downloads_total",
  help: "Individual photo download presigned URLs generated",
  labelNames: ["actor"] as const,
  registers: [register],
});

// One increment per archive part a guest actually pulls — counted in the
// part-redirect handler, the only place bytes leave S3 (PIXSHAR-3). Opening the
// download page is a read and counts nothing: it hands out no presigned URL, and
// counting page loads (or SSE ticks) measured neither presigns nor downloads.
export const archiveDownloadsTotal = new Counter({
  name: "pixshar_archive_downloads_total",
  help: "Archive ZIP parts downloaded by guests (part-redirect hits)",
  labelNames: ["quality"] as const,
  registers: [register],
});

// Idle expiry (PIXSHAR-4). Written by expireArchive — both by the periodic
// reaper (worker process) and by the admin "release archive" endpoint (API
// process); each process exposes its own /metrics, Prometheus sums them.
export const archiveExpiredTotal = new Counter({
  name: "pixshar_archive_expired_total",
  help: "Archives expired: ZIP objects reclaimed from S3, membership kept",
  labelNames: ["quality"] as const,
  registers: [register],
});

export const archiveBytesReclaimedTotal = new Counter({
  name: "pixshar_archive_bytes_reclaimed_total",
  help: "Bytes freed from S3 by archive expiry",
  labelNames: ["quality"] as const,
  registers: [register],
});

// Lazy build (PIXSHAR-5). Counted where a build is *scheduled from an idle
// state* — one increment per build cycle initiated, not per trigger call: a
// second photo landing during the debounce window extends the same cycle and
// does not count again. `trigger` is why the bytes are being spent:
//   first_build         a guest asked for a variant that never existed
//   on_demand_rebuild   a guest asked for a variant whose bytes had expired
//   append              a photo arrived while the variant was alive (eager append)
//   admin               the admin forced a build/rebuild
// The append counts are emitted by the image-processor process, the rest by the
// API process; each exposes its own /metrics and Prometheus sums them.
export const archiveBuildsTotal = new Counter({
  name: "pixshar_archive_builds_total",
  help: "Archive builds scheduled, by variant and what triggered them",
  labelNames: ["quality", "trigger"] as const,
  registers: [register],
});

export const photoUploadsInitiatedTotal = new Counter({
  name: "pixshar_photo_uploads_initiated_total",
  help: "Photo upload presigned PUT URLs issued (new files only, not resumes)",
  labelNames: ["actor"] as const,
  registers: [register],
});

export const photoUploadsCompletedTotal = new Counter({
  name: "pixshar_photo_uploads_completed_total",
  help: "Photo uploads confirmed complete by the client",
  labelNames: ["actor"] as const,
  registers: [register],
});

export const imageProcessingTotal = new Counter({
  name: "pixshar_image_processing_total",
  help: "Image processing attempts by outcome",
  labelNames: ["result"] as const,
  registers: [register],
});

export const httpRequestsTotal = new Counter({
  name: "pixshar_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

export const httpRequestDuration = new Histogram({
  name: "pixshar_http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const imageProcessingDuration = new Histogram({
  name: "pixshar_image_processing_duration_seconds",
  help: "Image resize + upload duration in seconds",
  labelNames: ["result"] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

export const archiveBuildDuration = new Histogram({
  name: "pixshar_archive_build_duration_seconds",
  help: "ZIP archive build duration in seconds",
  labelNames: ["result"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [register],
});

// How long an expired archive stayed gone before someone asked for it back.
// This is the metric that tells the operator whether DOWNLOAD_ARCHIVE_TTL_DAYS
// is cutting into live usage: a pile of observations in the low buckets means
// the TTL is expiring archives guests still want. Buckets are 1h/6h/1d/3d/7d/
// 14d/30d, since the TTL itself is measured in days.
export const archiveExpiryToRebuildSeconds = new Histogram({
  name: "pixshar_archive_expiry_to_rebuild_seconds",
  help: "Seconds between an archive expiring and a request rebuilding it",
  labelNames: ["quality"] as const,
  buckets: [3600, 21600, 86400, 259200, 604800, 1209600, 2592000],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Worker / pg-boss metrics (emitted by image-processor process)
// ---------------------------------------------------------------------------

export const workerJobsCompleted = new Counter({
  name: "pixshar_worker_jobs_completed_total",
  help: "pg-boss jobs completed by this worker pod",
  labelNames: ["queue", "result"] as const,
  registers: [register],
});

export const workerJobDuration = new Histogram({
  name: "pixshar_worker_job_duration_seconds",
  help: "End-to-end job duration in the worker (from queue pickup to completion)",
  labelNames: ["queue"] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [register],
});

export const pgbossQueueDepth = new Gauge({
  name: "pixshar_pgboss_queue_depth",
  help: "Jobs in pg-boss queue by name (state=created)",
  labelNames: ["queue"] as const,
  registers: [register],
  async collect() {
    try {
      const rows = await prisma.$queryRaw<{ name: string; count: bigint }[]>`
        SELECT name, COUNT(*) AS count
        FROM pgboss.job
        WHERE state = 'created'
        GROUP BY name
      `;
      this.reset();
      for (const row of rows) {
        this.set({ queue: row.name }, Number(row.count));
      }
    } catch {
      // pg-boss schema may not exist yet on fresh start.
    }
  },
});
