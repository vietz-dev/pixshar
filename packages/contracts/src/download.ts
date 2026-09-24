import { z } from "zod";

/** The two archive variants: Kompakt (display-sized) and Original. */
export const quality = z.enum(["DISPLAY", "ORIGINAL"]);
export type Quality = z.infer<typeof quality>;

/**
 * Admin-facing build status for one variant. `status` is "NONE" when no
 * DownloadJob row exists yet. Timestamps travel as ISO strings so this type
 * also describes the `download-status` SSE frames.
 */
export const downloadStatus = z.object({
  quality,
  status: z.string(),
  message: z.string(),
  photoCount: z.number(),
  processedPhotos: z.number(),
  uploadProgress: z.number(),
  totalPhotos: z.number(),
  totalSizeBytes: z.number().nullable(),
  partCount: z.number(),
  debounceUntil: z.string().nullable(),
  failureReason: z.string().nullable(),
  updatedAt: z.string(),
});
export type DownloadStatus = z.infer<typeof downloadStatus>;

/** One committed archive part, served by presigned URL (never proxied bytes). */
export const downloadPart = z.object({
  index: z.number(),
  url: z.string().nullable(),
  sizeBytes: z.number(),
  photoCount: z.number(),
  membershipSig: z.string(),
  rebuilding: z.boolean(),
});
export type DownloadPart = z.infer<typeof downloadPart>;

/** Guest-facing archive state for one variant. */
export const downloadPayload = z.object({
  status: z.string(),
  parts: z.array(downloadPart),
  partCount: z.number(),
  totalSizeBytes: z.number(),
  photoCount: z.number(),
  building: z.boolean(),
  message: z.string(),
  debounceUntil: z.string().nullable().optional(),
  processedPhotos: z.number().optional(),
  uploadProgress: z.number().optional(),
});
export type DownloadPayload = z.infer<typeof downloadPayload>;

/**
 * Both variants in one round trip, with the default variant's fields also
 * spread at the top level (back-compat with pre-variant clients).
 */
export const bothVariantsPayload = downloadPayload.extend({
  defaultQuality: quality,
  variants: z.object({ DISPLAY: downloadPayload, ORIGINAL: downloadPayload }),
});
export type BothVariantsPayload = z.infer<typeof bothVariantsPayload>;
