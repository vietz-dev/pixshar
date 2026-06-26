import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(0);

export interface PhotoStatusPayload {
  pending: number;
  processed: number;
  failed: number;
  total: number;
}

export interface DownloadStatusPayload {
  status: string;
  message: string;
  photoCount: number;
  processedPhotos: number;
  uploadProgress: number;
  totalPhotos: number;
  zipSizeBytes: number | null;
  debounceUntil: string | null;
  failureReason: string | null;
  updatedAt: string;
}

export interface PhotoProcessedPayload {
  id: string;
  thumbUrl: string;
  displayUrl: string;
  photographerName: string | null;
}

export function emitPhotoStatus(eventId: string, payload: PhotoStatusPayload): void {
  bus.emit(`photo-status:${eventId}`, payload);
}

export function onPhotoStatus(
  eventId: string,
  cb: (p: PhotoStatusPayload) => void
): () => void {
  bus.on(`photo-status:${eventId}`, cb);
  return () => bus.off(`photo-status:${eventId}`, cb);
}

export function emitDownloadStatus(eventId: string, payload: DownloadStatusPayload): void {
  bus.emit(`download-status:${eventId}`, payload);
}

export function onDownloadStatus(
  eventId: string,
  cb: (p: DownloadStatusPayload) => void
): () => void {
  bus.on(`download-status:${eventId}`, cb);
  return () => bus.off(`download-status:${eventId}`, cb);
}

export function emitPhotoProcessed(eventId: string, payload: PhotoProcessedPayload): void {
  bus.emit(`photo-processed:${eventId}`, payload);
}

export function onPhotoProcessed(
  eventId: string,
  cb: (p: PhotoProcessedPayload) => void
): () => void {
  bus.on(`photo-processed:${eventId}`, cb);
  return () => bus.off(`photo-processed:${eventId}`, cb);
}
