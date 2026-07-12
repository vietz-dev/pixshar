import type { DownloadJobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
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

// How long a presigned archive-part URL stays signable. Short on purpose: S3
// validates the signature at request *start*, so an in-flight multi-GB transfer
// is not cut off when the window elapses — and a link that leaks out of the
// gallery goes dead quickly. The guest never sees this URL directly; the
// part-redirect endpoint mints a fresh one per click.
export const ARCHIVE_PART_PRESIGN_SECONDS = 15 * 60;

// Does this part currently have ZIP bytes on S3? EXPIRED parts keep their row
// (the membership is the durable thing) but their object is gone.
export function partHasObject(part: { key: string | null; status: string }): boolean {
  return Boolean(part.key) && part.status !== "EXPIRED";
}

// An EXPIRED job's objects are gone, or are being deleted right now. Expiry
// claims the job (READY → EXPIRED) *before* it touches S3 and flips the part
// rows only *after* the objects are gone; this gate is what makes that window
// invisible — a part is never offered while its bytes are being reclaimed, and
// a crash mid-expiry can never leave a guest clicking a dead S3 link.
function jobHoldsObjects(job: { status: DownloadJobStatus }): boolean {
  return job.status !== "EXPIRED";
}

// The guest's part link. It points at the API, not at S3: the redirect endpoint
// stamps the job's idle clock and only then hands the browser a fresh presigned
// URL. Handing out the S3 URL here would make the real download invisible — the
// API would only ever learn that the download *page* was opened.
export function partDownloadUrl(slug: string, quality: Quality, partIndex: number): string {
  return `/api/gallery/${slug}/download/part/${partIndex}?quality=${quality}`;
}

// Content-Disposition for a part's S3 response. Kompakt gets a distinct filename
// base so both variants can coexist in the guest's downloads folder without
// overwriting each other; ORIGINAL keeps the plain slug (back-compat). A single
// part is named after the gallery; multiple parts carry "-part-N-of-M".
export function partContentDisposition(
  slug: string,
  quality: Quality,
  partIndex: number,
  partCount: number
): string {
  const fileBase = quality === "DISPLAY" ? `${slug}-kompakt` : slug;
  const name = partCount === 1 ? `${fileBase}.zip` : `${fileBase}-part-${partIndex}-of-${partCount}.zip`;
  return `attachment; filename="${name}"`;
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
//
// Part URLs are API URLs, not presigned S3 URLs — so this payload signs nothing,
// which is what makes it cheap enough to re-emit on every SSE tick of a 20-part
// gallery.
export async function buildDownloadPayload(
  eventId: string,
  slug: string,
  quality: Quality = DEFAULT_QUALITY
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
  const downloadable = jobHoldsObjects(job) ? job.parts.filter(partHasObject) : [];
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

  const parts: DownloadPart[] = downloadable.map((p) => ({
    index: p.partIndex,
    sizeBytes: Number(p.sizeBytes),
    photoCount: p.photoCount,
    membershipSig: p.membershipSig,
    rebuilding: p.status === "STALE",
    url: partDownloadUrl(slug, quality, p.partIndex),
  }));

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
  slug: string
): Promise<BothVariantsPayload> {
  // Lazy creation of the Kompakt job on first demand.
  await ensureJob(eventId, "DISPLAY").catch(() => {});

  const [display, original] = await Promise.all([
    buildDownloadPayload(eventId, slug, "DISPLAY"),
    buildDownloadPayload(eventId, slug, "ORIGINAL"),
  ]);

  const variants: Record<Quality, DownloadPayload> = { DISPLAY: display, ORIGINAL: original };
  const def = variants[GUEST_DEFAULT_QUALITY];
  return { ...def, defaultQuality: GUEST_DEFAULT_QUALITY, variants };
}

export interface PartDownloadTicket {
  key: string;
  contentDisposition: string;
}

/**
 * Resolve one archive part for the guest's part-redirect endpoint — and stamp
 * the job's idle clock while doing so. This is the ONLY place the API learns
 * that a guest actually pulled bytes (the payload/SSE endpoints are reads and
 * must leave the clock alone), and it stamps per (event, variant): downloading
 * Kompakt never keeps the Original archive alive.
 *
 * Returns null when the part has no committed S3 object — EXPIRED or not yet
 * built — so the caller answers 404 instead of redirecting to a dead object.
 */
export async function registerPartDownload(
  eventId: string,
  slug: string,
  quality: Quality,
  partIndex: number
): Promise<PartDownloadTicket | null> {
  const job = await prisma.downloadJob.findUnique({
    where: jobWhere(eventId, quality),
    include: { parts: { orderBy: { partIndex: "asc" } } },
  });
  if (!job || !jobHoldsObjects(job)) return null;

  // Part count is over the downloadable parts, exactly as the payload counts
  // them — so the "-part-N-of-M" filename a guest gets matches what the page shows.
  const downloadable = job.parts.filter(partHasObject);
  const part = downloadable.find((p) => p.partIndex === partIndex);
  if (!part?.key) return null;

  await prisma.downloadJob.update({
    where: { id: job.id },
    data: { lastDownloadedAt: new Date() },
  });

  return {
    key: part.key,
    contentDisposition: partContentDisposition(slug, quality, part.partIndex, downloadable.length),
  };
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
