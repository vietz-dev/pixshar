// Client side of the direct-to-S3 presigned upload + dedup flow.
//
// Pipeline per batch:
//   1. SHA-256 each file in the browser (dedup key) + validate size/type.
//   2. POST {initUrl} with the file metadata → server dedups and returns a
//      presigned PUT URL for every file that still needs uploading.
//   3. PUT the bytes straight to S3 (never through the API), with progress.
//   4. POST {completeUrl} with the ids that landed → server starts processing.

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB — keep in sync with apps/api validate.ts
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

export type ItemStatus = "uploading" | "done" | "error" | "skipped";

export interface UploadFileItem {
  uid: string;
  file: File;
}

export interface PresignedUploadOptions {
  items: UploadFileItem[];
  initUrl: string;
  completeUrl: string;
  photographerName?: string;
  onStatus: (uid: string, status: ItemStatus, progress?: number) => void;
  shouldAbort?: () => boolean;
  batchSize?: number;
}

function fileExt(file: File): string {
  return file.name.split(".").pop()?.toLowerCase() || "jpg";
}

// The content type used for BOTH the init request and the PUT header — they must
// match exactly or S3 rejects the presigned signature.
export function fileContentType(file: File): string {
  if (file.type && ALLOWED_MIME.includes(file.type)) return file.type;
  return MIME_BY_EXT[fileExt(file)] || "image/jpeg";
}

export function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) return `"${file.name}" exceeds the 50MB limit`;
  if (file.type && !ALLOWED_MIME.includes(file.type)) {
    return `"${file.name}" is not a supported image type`;
  }
  return null;
}

export async function sha256HexFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Hash files with bounded concurrency so a 100-file batch doesn't read every
// ArrayBuffer into memory at once.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function putToS3(
  file: File,
  uploadUrl: string,
  contentType: string,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`S3 upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("S3 upload network error"));
    xhr.send(file);
  });
}

interface InitResult {
  fileHash: string;
  duplicate: boolean;
  status: "PENDING" | "DUPLICATE";
  id: string | null;
  uploadUrl?: string;
  contentType?: string;
}

/**
 * Run the full presigned upload for a batch of files. Resolves once every item
 * has reached a terminal state (done / skipped / error) and processing for the
 * uploaded ones has been kicked off.
 */
export async function presignedUpload(opts: PresignedUploadOptions): Promise<void> {
  const { items, initUrl, completeUrl, photographerName, onStatus, shouldAbort } = opts;
  const batchSize = opts.batchSize ?? 4;
  if (items.length === 0) return;

  if (typeof crypto === "undefined" || !crypto.subtle) {
    // Hashing requires a secure context (HTTPS or localhost).
    for (const it of items) onStatus(it.uid, "error");
    throw new Error("Secure context required for uploads (HTTPS or localhost).");
  }

  // 1. Validate + hash (bounded concurrency). Build metadata aligned with items.
  const metas = await mapPool(items, batchSize, async (it) => {
    const err = validateFile(it.file);
    if (err) {
      onStatus(it.uid, "error");
      return null;
    }
    const contentType = fileContentType(it.file);
    return {
      fileName: it.file.name,
      ext: fileExt(it.file),
      contentType,
      size: it.file.size,
      fileHash: await sha256HexFile(it.file),
    };
  });

  // Only files that passed validation go to the server (index-aligned subset).
  const valid = items
    .map((it, i) => ({ it, meta: metas[i] }))
    .filter((x): x is { it: UploadFileItem; meta: NonNullable<(typeof metas)[number]> } => x.meta !== null);

  if (valid.length === 0) return;

  // 2. Init — server dedups and returns URLs for the files that need uploading.
  const res = await fetch(initUrl, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: valid.map((v) => v.meta),
      ...(photographerName ? { photographerName } : {}),
    }),
  });
  if (!res.ok) {
    for (const v of valid) onStatus(v.it.uid, "error");
    throw new Error("Upload init failed");
  }
  const { photos } = (await res.json()) as { photos: InitResult[] };

  // Results are index-aligned with the files we sent.
  const fresh: { uid: string; file: File; uploadUrl: string; contentType: string; id: string }[] = [];
  photos.forEach((r, i) => {
    const v = valid[i];
    if (!v) return;
    if (r.duplicate || !r.uploadUrl || !r.id) {
      onStatus(v.it.uid, "skipped");
    } else {
      fresh.push({
        uid: v.it.uid,
        file: v.it.file,
        uploadUrl: r.uploadUrl,
        contentType: r.contentType ?? fileContentType(v.it.file),
        id: r.id,
      });
    }
  });

  // 3. Upload fresh files directly to S3, capped at batchSize concurrent PUTs.
  const uploadedIds: string[] = [];
  let idx = 0;
  while (idx < fresh.length) {
    if (shouldAbort?.()) break;
    const batch = fresh.slice(idx, idx + batchSize);
    batch.forEach((b) => onStatus(b.uid, "uploading", 0));
    await Promise.allSettled(
      batch.map(async (b) => {
        try {
          await putToS3(b.file, b.uploadUrl, b.contentType, (pct) => onStatus(b.uid, "uploading", pct));
          onStatus(b.uid, "done", 100);
          uploadedIds.push(b.id);
        } catch {
          onStatus(b.uid, "error", 0);
        }
      })
    );
    idx += batchSize;
  }

  // 4. Tell the server which uploads landed so it can start processing.
  if (uploadedIds.length > 0) {
    await fetch(completeUrl, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoIds: uploadedIds }),
    }).catch(() => {});
  }
}
