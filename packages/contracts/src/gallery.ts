import { oc } from "@orpc/contract";
import { bothVariantsPayload } from "./download.js";
import { galleryUpload } from "./upload.js";
import { z } from "zod";

/** Public event info shown on the gallery password gate — no session needed. */
export const galleryInfo = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});
export type GalleryInfo = z.infer<typeof galleryInfo>;

/** A photo as a guest sees it: presigned URLs only, never S3 keys. */
export const galleryPhoto = z.object({
  id: z.string(),
  photographerName: z.string().nullable(),
  thumbUrl: z.string(),
  displayUrl: z.string(),
  status: z.string(),
  placeholderDataUrl: z.string().nullable(),
});
export type GalleryPhoto = z.infer<typeof galleryPhoto>;

/** The guest gallery view payload. */
export const galleryData = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  photos: z.array(galleryPhoto),
});
export type GalleryData = z.infer<typeof galleryData>;

const success = z.object({ success: z.literal(true) });

export const gallery = {
  info: oc
    .input(z.object({ slug: z.string() }))
    .errors({ NOT_FOUND: {} })
    .output(galleryInfo),

  /**
   * Password check. On success the response carries the `gallery_<slug>`
   * session cookie, set from inside the procedure via oRPC's response-headers
   * plugin — every other gallery procedure requires it.
   */
  unlock: oc
    .input(z.object({ slug: z.string(), password: z.string().min(1).max(128) }))
    .errors({ NOT_FOUND: {}, UNAUTHORIZED: {}, TOO_MANY_REQUESTS: {} })
    .output(success),

  get: oc
    .input(z.object({ slug: z.string() }))
    .errors({ UNAUTHORIZED: {}, TOO_MANY_REQUESTS: {} })
    .output(galleryData),

  /** Presigned, attachment-dispositioned URL for one original photo. */
  photoDownload: oc
    .input(z.object({ slug: z.string(), photoId: z.string() }))
    .errors({ UNAUTHORIZED: {}, NOT_FOUND: {}, TOO_MANY_REQUESTS: {} })
    .output(z.object({ url: z.string() })),

  /** Both archive variants in one round trip, with presigned part URLs. */
  download: oc
    .input(z.object({ slug: z.string() }))
    .errors({ UNAUTHORIZED: {}, NOT_FOUND: {}, TOO_MANY_REQUESTS: {} })
    .output(bothVariantsPayload),

  /** Guest upload bookends — same presigned flow as the admin's. */
  upload: galleryUpload,
};
