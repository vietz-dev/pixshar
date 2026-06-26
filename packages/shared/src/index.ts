export type PhotoStatus = "PENDING" | "PROCESSED" | "FAILED";
export type EventStatus = "PROCESSING" | "READY";
export type UploadSource = "ADMIN" | "GUEST";

export interface Photo {
  id: string;
  eventId: string;
  photographerName: string | null;
  originalKey: string;
  displayKey: string;
  thumbKey: string;
  status: PhotoStatus;
  uploadedBy: UploadSource;
  fileHash: string | null;
  createdAt: string;
}

export interface Event {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  passwordHash: string;
  status: EventStatus;
  createdById: string;
  createdAt: string;
  photos?: Photo[];
}

export interface GalleryPhoto {
  id: string;
  photographerName: string | null;
  thumbUrl: string;
  displayUrl: string;
  status: PhotoStatus;
}

export interface GalleryEvent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  photos: GalleryPhoto[];
}

export interface CreateEventBody {
  name: string;
  slug: string;
  description?: string;
  password: string;
}

export interface UnlockBody {
  password: string;
}

export interface UploadStatus {
  pending: number;
  processed: number;
  failed: number;
  total: number;
}

// ---- Direct-to-S3 presigned upload + dedup ----

// Per-file metadata the client sends to the init endpoint. The client computes
// fileHash (SHA-256 hex of the original bytes) and validates size/type locally.
export interface UploadInitFileMeta {
  fileName: string;
  ext: string;
  contentType: string;
  size: number;
  fileHash: string;
}

export interface UploadInitRequest {
  files: UploadInitFileMeta[];
  // Guest uploads only; ignored for admin.
  photographerName?: string;
}

// One result per requested file. duplicate=true means it already exists for this
// event (no row created, no URL issued) — the client marks it as skipped and
// never uploads its bytes. Fresh files get a presigned PUT uploadUrl.
export interface UploadInitResult {
  fileHash: string;
  duplicate: boolean;
  status: "PENDING" | "DUPLICATE";
  id: string | null;
  uploadUrl?: string;
  contentType?: string;
}

export interface UploadInitResponse {
  photos: UploadInitResult[];
}

// Sent after the client finishes PUTting originals to S3 — triggers processing.
export interface UploadCompleteRequest {
  photoIds: string[];
}
