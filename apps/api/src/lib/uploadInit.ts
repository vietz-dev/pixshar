import { z } from "zod";
import { Effect } from "effect";
import { prisma } from "./prisma.js";
import { getPresignedPutUrl, deleteS3Object } from "./s3.js";
import { MAX_FILE_SIZE, MAX_FILES_PER_UPLOAD, ALLOWED_MIME_TYPES } from "./validate.js";
import { processImage } from "../services/imageProcessor.js";
import type { UploadInitResult } from "@pixshar/shared";

// Shared logic for the presigned, deduplicated upload flow used by both the
// admin (upload.ts) and guest (gallery.ts) routes.

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export const uploadInitSchema = z.object({
  files: z
    .array(
      z.object({
        fileName: z.string().min(1).max(255),
        ext: z.string().min(1).max(10),
        contentType: z.enum(ALLOWED_MIME_TYPES as [string, ...string[]]),
        size: z.number().int().positive().max(MAX_FILE_SIZE),
        fileHash: z.string().regex(/^[a-f0-9]{64}$/, "fileHash must be 64-char lowercase hex"),
      })
    )
    .min(1)
    .max(MAX_FILES_PER_UPLOAD),
  photographerName: z.string().max(100).optional(),
});

export const uploadCompleteSchema = z.object({
  photoIds: z.array(z.string().min(1)).min(1).max(MAX_FILES_PER_UPLOAD),
});

export type UploadInitInput = z.infer<typeof uploadInitSchema>;

function isP2002(e: unknown): boolean {
  return !!e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002";
}

/**
 * Dedup the requested files for an event and hand back presigned PUT URLs.
 *
 * Per hash:
 *  - a PROCESSED row exists  → true duplicate (no URL; client skips the upload).
 *  - a PENDING row exists    → resume: re-issue a URL for that same row. This is
 *    what lets a failed/abandoned upload be retried — the byte never landed, so
 *    the row must not be treated as a duplicate.
 *  - a FAILED row exists     → recycle it (delete + drop orphaned original) so a
 *    fresh row can take the (eventId, fileHash) pair.
 *  - otherwise               → create a fresh PENDING row + URL.
 *
 * The @@unique([eventId, fileHash]) constraint + P2002 handling make this safe
 * under concurrent requests for the same file.
 */
export async function initUpload(opts: {
  eventId: string;
  uploadedBy: "ADMIN" | "GUEST";
  photographerName: string | null;
  files: UploadInitInput["files"];
}): Promise<UploadInitResult[]> {
  const { eventId, uploadedBy, photographerName, files } = opts;
  const hashes = files.map((f) => f.fileHash);

  // Recycle FAILED rows (free the unique pair) and drop any orphaned originals.
  const failed = await prisma.photo.findMany({
    where: { eventId, fileHash: { in: hashes }, status: "FAILED" },
    select: { id: true, originalKey: true },
  });
  if (failed.length) {
    await prisma.photo.deleteMany({ where: { id: { in: failed.map((f) => f.id) } } });
    await Promise.all(
      failed.filter((f) => f.originalKey).map((f) => deleteS3Object(f.originalKey).catch(() => {}))
    );
  }

  const existing = await prisma.photo.findMany({
    where: { eventId, fileHash: { in: hashes }, status: { in: ["PENDING", "PROCESSED"] } },
    select: { id: true, fileHash: true, originalKey: true, status: true },
  });
  const processed = new Set<string>();
  // hash → resumable PENDING row. Also accumulates rows created in this request
  // so a file repeated within one batch resumes the first row.
  const pending = new Map<string, { id: string; originalKey: string }>();
  for (const e of existing) {
    if (!e.fileHash) continue;
    if (e.status === "PROCESSED") processed.add(e.fileHash);
    else pending.set(e.fileHash, { id: e.id, originalKey: e.originalKey });
  }

  const duplicate = (fileHash: string): UploadInitResult => ({
    fileHash,
    duplicate: true,
    status: "DUPLICATE",
    id: null,
  });
  const resume = async (
    fileHash: string,
    id: string,
    originalKey: string,
    contentType: string
  ): Promise<UploadInitResult> => ({
    fileHash,
    duplicate: false,
    status: "PENDING",
    id,
    uploadUrl: await getPresignedPutUrl(originalKey, contentType, 900),
    contentType,
  });

  const results: UploadInitResult[] = [];
  for (const f of files) {
    if (processed.has(f.fileHash)) {
      results.push(duplicate(f.fileHash));
      continue;
    }
    const existingPending = pending.get(f.fileHash);
    if (existingPending && existingPending.originalKey) {
      results.push(await resume(f.fileHash, existingPending.id, existingPending.originalKey, f.contentType));
      continue;
    }

    const ext = EXT_BY_MIME[f.contentType] ?? "jpg";
    try {
      const photo = await prisma.photo.create({
        data: {
          eventId,
          photographerName,
          originalKey: "",
          displayKey: "",
          thumbKey: "",
          status: "PENDING",
          uploadedBy,
          fileHash: f.fileHash,
        },
      });
      const originalKey = `${eventId}/${photo.id}/original.${ext}`;
      await prisma.photo.update({ where: { id: photo.id }, data: { originalKey } });
      pending.set(f.fileHash, { id: photo.id, originalKey });
      results.push(await resume(f.fileHash, photo.id, originalKey, f.contentType));
    } catch (e) {
      if (!isP2002(e)) throw e;
      // Concurrent request created the row first — resume it, or skip if it's done.
      const ex = await prisma.photo.findFirst({
        where: { eventId, fileHash: f.fileHash },
        select: { id: true, originalKey: true, status: true },
      });
      if (ex && ex.status !== "PROCESSED" && ex.originalKey) {
        results.push(await resume(f.fileHash, ex.id, ex.originalKey, f.contentType));
      } else {
        results.push(duplicate(f.fileHash));
      }
    }
  }

  return results;
}

/**
 * After the client has PUT the originals to S3, kick off processing for the
 * given PENDING photos belonging to this event. Idempotent: rows that are
 * missing, already PROCESSED, or belong to another event are ignored.
 */
export async function completeUpload(eventId: string, photoIds: string[]): Promise<void> {
  const photos = await prisma.photo.findMany({
    where: { id: { in: photoIds }, eventId, status: "PENDING" },
    select: { id: true, originalKey: true, fileHash: true },
  });

  for (const p of photos) {
    if (!p.originalKey || !p.fileHash) continue;
    const ext = p.originalKey.split(".").pop() || "jpg";
    Effect.runFork(
      processImage({ photoId: p.id, eventId, ext, originalKey: p.originalKey, fileHash: p.fileHash })
    );
  }
}
