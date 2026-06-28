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

export const archiveDownloadsTotal = new Counter({
  name: "pixshar_archive_downloads_total",
  help: "Archive ZIP download presigned URLs generated",
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
