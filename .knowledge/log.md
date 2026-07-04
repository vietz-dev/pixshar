# Pixshar Knowledge Bundle — Update Log

## 2026-07-03
* **Initialization**: Created foundational OKF bundle covering product overview, architecture, data model, API, and architectural decisions.
* **Creation**: Added [overview](/overview.md), [frontend](/architecture/frontend.md), [backend](/architecture/backend.md), [storage](/architecture/storage.md), [auth](/architecture/auth.md), [image processing](/architecture/image-processing.md), [archive generation](/architecture/archive-generation.md).
* **Creation**: Added data model concepts for [events](/data-model/events.md), [photos](/data-model/photos.md), [download jobs](/data-model/download-jobs.md).
* **Creation**: Added API concepts for [gallery](/api/gallery-api.md), [admin](/api/admin-api.md), [upload](/api/upload-api.md).
* **Creation**: Added decision records for [presigned URLs](/decisions/presigned-urls.md), [gallery sessions](/decisions/gallery-sessions.md), [single S3 bucket](/decisions/single-s3-bucket.md), [durable queue](/decisions/durable-queue.md), [multi-part archive](/decisions/multi-part-archive.md).

## 2026-07-05
* **Change**: Archive parts are now **incremental and immutable**. A build no longer rewrites the whole archive on every upload — it appends only newly-uploaded photos as new parts and rebuilds a part in place only when a photo inside it is deleted. Updated [archive generation](/architecture/archive-generation.md), [multi-part archive decision](/decisions/multi-part-archive.md), [download jobs](/data-model/download-jobs.md).
* **Change**: Part identity: each part carries a `membershipSig` (content identity for client download-tracking) and a `generation` (versioned S3 key for old/new coexistence during a rebuild). New `DownloadArchivePartEntry` join table records durable part membership.
* **Change**: Admin controls split — `POST /download/build-now` (skip debounce, keep FIFO) and `POST /download/rebuild-all` (membership-preserving full rebuild) replace `POST /download/build`.
