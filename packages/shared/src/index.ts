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
