import { oc } from "@orpc/contract";
import { z } from "zod";

/**
 * Upload limits. These live in the contract because both the request schema and
 * the API's byte-level checks (`apps/api/src/lib/validate.ts`, which re-exports
 * them) must agree on the same numbers.
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

/** Client-declared metadata for one file; `fileHash` is the dedup key. */
export const uploadInitFileMeta = z.object({
  fileName: z.string().min(1).max(255),
  ext: z.string().min(1).max(10),
  contentType: z.enum(ALLOWED_MIME_TYPES),
  size: z.number().int().positive().max(MAX_FILE_SIZE),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/, "fileHash must be 64-char lowercase hex"),
});
export type UploadInitFileMeta = z.infer<typeof uploadInitFileMeta>;

/**
 * One result per requested file, index-aligned with the request. `duplicate`
 * means the event already has those bytes — no row, no URL, client skips it.
 */
export const uploadInitResult = z.object({
  fileHash: z.string(),
  duplicate: z.boolean(),
  status: z.enum(["PENDING", "DUPLICATE"]),
  id: z.string().nullable(),
  uploadUrl: z.string().optional(),
  contentType: z.string().optional(),
});
export type UploadInitResult = z.infer<typeof uploadInitResult>;

export const uploadInitResponse = z.object({ photos: z.array(uploadInitResult) });
export type UploadInitResponse = z.infer<typeof uploadInitResponse>;

/** Processing counters for one event — also the SSE `photo-status` payload. */
export const uploadStatus = z.object({
  pending: z.number(),
  processed: z.number(),
  failed: z.number(),
  total: z.number(),
});
export type UploadStatus = z.infer<typeof uploadStatus>;

const files = z.array(uploadInitFileMeta).min(1);
const photographerName = z.string().max(100).optional();
const photoIds = z.array(z.string().min(1)).min(1);
const ok = z.object({ ok: z.literal(true) });

/** Admin upload — the bytes go browser → S3, never through the API. */
export const upload = {
  init: oc
    .input(z.object({ eventId: z.string(), files, photographerName }))
    .errors({ NOT_FOUND: {}, FORBIDDEN: {}, TOO_MANY_REQUESTS: {} })
    .output(uploadInitResponse),

  complete: oc
    .input(z.object({ eventId: z.string(), photoIds }))
    .errors({ NOT_FOUND: {}, FORBIDDEN: {} })
    .output(ok),

  status: oc
    .input(z.object({ eventId: z.string() }))
    .errors({ NOT_FOUND: {}, FORBIDDEN: {}, TOO_MANY_REQUESTS: {} })
    .output(uploadStatus),
};

/** Guest upload — same flow, authorised by the gallery session cookie. */
export const galleryUpload = {
  init: oc
    .input(z.object({ slug: z.string(), files, photographerName }))
    .errors({ UNAUTHORIZED: {}, TOO_MANY_REQUESTS: {} })
    .output(uploadInitResponse),

  complete: oc
    .input(z.object({ slug: z.string(), photoIds }))
    .errors({ UNAUTHORIZED: {} })
    .output(ok),
};
