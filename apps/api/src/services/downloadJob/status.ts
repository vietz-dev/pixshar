import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import type { ArchiveQuality } from "@prisma/client";
import { emitDownloadStatus, PG_NOTIFY_CHANNEL } from "../../lib/eventBus.js";

// The two archive variants. `DEFAULT_QUALITY` = ORIGINAL keeps every historical
// call site (which knew only one archive per event) building the original,
// preserving behavior while the DISPLAY variant is added incrementally.
export type Quality = ArchiveQuality; // "DISPLAY" | "ORIGINAL"
export const DEFAULT_QUALITY: Quality = "ORIGINAL";
export const ALL_QUALITIES: Quality[] = ["DISPLAY", "ORIGINAL"];

// `?quality=` on every archive endpoint, admin and guest. One schema, so the two
// route files cannot drift apart on which variants exist. Validated, never
// coerced: several of these endpoints mutate (release reclaims the bytes), so a
// typo'd variant must be a 400 — silently falling back to a default would act on
// the WRONG archive. Omitting it means each surface's own default (ORIGINAL for
// admin, the historical single archive; DISPLAY/Kompakt for guests).
export const qualityQuerySchema = z.object({
  quality: z.enum(ALL_QUALITIES as [Quality, ...Quality[]]).optional(),
});

// Compound-unique selector for the (event, variant) job.
export function jobWhere(eventId: string, quality: Quality) {
  return { eventId_quality: { eventId, quality } };
}

export function statusMessage(status: string): string {
  switch (status) {
    case "NONE": return "No archive created yet.";
    case "DEBOUNCING": return "Waiting for uploads to settle.";
    case "QUEUED": return "Queued for building.";
    case "BUILDING": return "Building archive…";
    case "READY": return "Archive ready for download.";
    case "FAILED": return "Archive build failed.";
    case "CANCELLED": return "Archive build was cancelled.";
    case "EXPIRED": return "Archive expired — its files were reclaimed and can be rebuilt on request.";
    default: return "Unknown status.";
  }
}

export async function pushDownloadStatus(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<void> {
  const [job, totalPhotos] = await Promise.all([
    prisma.downloadJob.findUnique({ where: jobWhere(eventId, quality) }),
    prisma.photo.count({ where: { eventId, status: "PROCESSED" } }),
  ]);
  if (!job) return;
  emitDownloadStatus(eventId, {
    quality: job.quality,
    status: job.status,
    message: statusMessage(job.status),
    photoCount: job.photoCount,
    processedPhotos: job.processedPhotos,
    uploadProgress: job.uploadProgress,
    totalPhotos,
    totalSizeBytes: job.totalSizeBytes === null ? null : Number(job.totalSizeBytes),
    partCount: job.partCount,
    debounceUntil: job.debounceUntil?.toISOString() ?? null,
    failureReason: job.failureReason,
    updatedAt: job.updatedAt.toISOString(),
  });
}

// Emit locally (covers listeners in this process) AND via pg_notify so the API
// process's SSE streams fire when this code runs inside the worker container.
// The pg_notify listener re-reads the row and emits locally — it must call
// pushDownloadStatus, never this function, or the two processes would ping-pong.
export async function notifyDownloadStatus(
  eventId: string,
  quality: Quality = DEFAULT_QUALITY
): Promise<void> {
  pushDownloadStatus(eventId, quality).catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `SELECT pg_notify($1, $2)`,
      PG_NOTIFY_CHANNEL,
      JSON.stringify({ type: "download.status", eventId, quality })
    )
    .catch(() => {});
}

export function membershipSig(photoIds: string[]): string {
  // Stable content identity of a part: sha1 over its sorted photoId list. Changes
  // only when the part's photo set changes (a deletion) — never on a pure rebuild.
  return createHash("sha1").update([...photoIds].sort().join(",")).digest("hex");
}
