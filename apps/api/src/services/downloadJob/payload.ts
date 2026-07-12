import { prisma } from "../../lib/prisma.js";
import { getPresignedUrl } from "../../lib/s3.js";
import { DEFAULT_QUALITY, jobWhere, statusMessage, type Quality } from "./status.js";
import { ensureJob } from "./triggers.js";

export interface DownloadPart {
  index: number;
  url: string | null; // null when no downloadable object exists yet
  sizeBytes: number;
  photoCount: number;
  membershipSig: string; // client keys its "downloaded" tick on this
  rebuilding: boolean; // STALE: a newer version is being built; url serves the old one
}

export interface DownloadPayload {
  status: "READY" | "BUILDING" | "DEBOUNCING" | "FAILED" | "NONE";
  parts: DownloadPart[];
  partCount: number;
  totalSizeBytes: number;
  photoCount: number;
  building: boolean; // more content pending (job active or a part being rebuilt)
  message: string;
  debounceUntil?: string | null;
  processedPhotos?: number;
  uploadProgress?: number;
}

// The guest download endpoint returns BOTH variants in one response so the
// Kompakt/Original toggle can label both tabs from a single round trip.
// `defaultQuality` is DISPLAY (Kompakt) — the "I just want the photos" path.
// The default variant's fields are also spread at the top level so older
// clients that read `status`/`parts` directly keep working during the
// transition.
export interface BothVariantsPayload extends DownloadPayload {
  defaultQuality: Quality;
  variants: Record<Quality, DownloadPayload>;
}

// Part-aware download payload. Existing parts are served regardless of the job's
// state (partial availability): a guest can always grab the parts already built,
// even while newer photos are being appended or a part is being rebuilt.
export async function buildDownloadPayload(
  eventId: string,
  slug: string,
  quality: Quality = DEFAULT_QUALITY,
  expiresIn = 60 * 60
): Promise<DownloadPayload> {
  const job = await prisma.downloadJob.findUnique({
    where: jobWhere(eventId, quality),
    include: { parts: { orderBy: { partIndex: "asc" } } },
  });

  if (!job) {
    return { status: "NONE", parts: [], partCount: 0, totalSizeBytes: 0, photoCount: 0, building: false, message: statusMessage("NONE") };
  }

  const jobActive = job.status === "DEBOUNCING" || job.status === "QUEUED" || job.status === "BUILDING";
  const anyStale = job.parts.some((p) => p.status === "STALE");
  const building = jobActive || anyStale;

  // Only parts with a committed S3 object are offered for download.
  const downloadable = job.parts.filter((p) => p.key);
  const n = downloadable.length;

  if (n === 0) {
    const status: DownloadPayload["status"] =
      job.status === "FAILED" || job.status === "CANCELLED" ? "FAILED"
      : job.status === "DEBOUNCING" ? "DEBOUNCING"
      : job.status === "QUEUED" || job.status === "BUILDING" ? "BUILDING"
      : "NONE";
    return {
      status,
      parts: [],
      partCount: 0,
      totalSizeBytes: 0,
      photoCount: job.photoCount,
      building,
      message: statusMessage(status === "FAILED" ? "FAILED" : status === "DEBOUNCING" ? "DEBOUNCING" : status === "BUILDING" ? "BUILDING" : "NONE"),
      debounceUntil: job.debounceUntil?.toISOString() ?? null,
      processedPhotos: job.processedPhotos,
      uploadProgress: job.uploadProgress,
    };
  }

  // Kompakt downloads get a distinct filename base so both variants can coexist
  // in the guest's downloads folder without overwriting each other. ORIGINAL
  // keeps today's plain slug filename (back-compat).
  const fileBase = quality === "DISPLAY" ? `${slug}-kompakt` : slug;
  const parts: DownloadPart[] = await Promise.all(
    downloadable.map(async (p) => ({
      index: p.partIndex,
      sizeBytes: Number(p.sizeBytes),
      photoCount: p.photoCount,
      membershipSig: p.membershipSig,
      rebuilding: p.status === "STALE",
      url: await getPresignedUrl(
        p.key,
        "get",
        expiresIn,
        n === 1
          ? `attachment; filename="${fileBase}.zip"`
          : `attachment; filename="${fileBase}-part-${p.partIndex}-of-${n}.zip"`
      ),
    }))
  );

  return {
    status: "READY",
    parts,
    partCount: n,
    totalSizeBytes: parts.reduce((sum, p) => sum + p.sizeBytes, 0),
    photoCount: job.parts.reduce((sum, p) => sum + p.photoCount, 0),
    building,
    message: building ? "Some parts are still being prepared." : statusMessage("READY"),
    debounceUntil: job.debounceUntil?.toISOString() ?? null,
    processedPhotos: job.processedPhotos,
    uploadProgress: job.uploadProgress,
  };
}

// Guest default variant — Kompakt is the sensible lightweight option.
export const GUEST_DEFAULT_QUALITY: Quality = "DISPLAY";

// Build the both-variants guest payload. Lazily materializes the DISPLAY job for
// events that predate the variant (so an older event's compressed archive
// appears shortly after the guest first opens the download page) — no mass
// backfill. Returns each variant's payload plus the default variant spread at
// the top level for back-compat.
export async function buildBothVariantsPayload(
  eventId: string,
  slug: string,
  expiresIn = 60 * 60
): Promise<BothVariantsPayload> {
  // Lazy creation of the Kompakt job on first demand.
  await ensureJob(eventId, "DISPLAY").catch(() => {});

  const [display, original] = await Promise.all([
    buildDownloadPayload(eventId, slug, "DISPLAY", expiresIn),
    buildDownloadPayload(eventId, slug, "ORIGINAL", expiresIn),
  ]);

  const variants: Record<Quality, DownloadPayload> = { DISPLAY: display, ORIGINAL: original };
  const def = variants[GUEST_DEFAULT_QUALITY];
  return { ...def, defaultQuality: GUEST_DEFAULT_QUALITY, variants };
}

export async function getDownloadJobStatus(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
) {
  const job = await prisma.downloadJob.findUnique({
    where: jobWhere(eventId, quality),
    include: { parts: { orderBy: { partIndex: "asc" } } },
  });
  if (!job) return null;

  return {
    id: job.id,
    quality: job.quality,
    status: job.status,
    photoCount: job.photoCount,
    processedPhotos: job.processedPhotos,
    uploadProgress: job.uploadProgress,
    totalSizeBytes: job.totalSizeBytes === null ? null : Number(job.totalSizeBytes),
    partCount: job.partCount,
    parts: job.parts.map((p) => ({
      partIndex: p.partIndex,
      key: p.key,
      sizeBytes: Number(p.sizeBytes),
      status: p.status,
      photoCount: p.photoCount,
      membershipSig: p.membershipSig,
      generation: p.generation,
    })),
    debounceUntil: job.debounceUntil,
    failureReason: job.failureReason,
    updatedAt: job.updatedAt,
  };
}
