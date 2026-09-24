# Pixshar Knowledge Bundle — Update Log

## 2026-09-24
* **Change**: The API became **contract-first**. All 27 JSON endpoints are now oRPC procedures declared in the new `packages/contracts` (`@pixshar/contracts`) and mounted on Hono at `/api/rpc`; `routes/{events,gallery,upload}.ts` are deleted and `packages/shared` is gone. Auth, ownership and rate limiting are procedure middleware (`adminOs`, `galleryOs`, `requireOwner`, `rateLimit`), and failures carry oRPC error codes instead of English strings. Added [Contract-first API](/decisions/contract-first-api.md); updated [backend](/architecture/backend.md), [gallery API](/api/gallery-api.md), [admin API](/api/admin-api.md), [upload API](/api/upload-api.md).
* **Change**: The four SSE streams moved into `routes/streams.ts` and stay plain Hono routes (an `EventSource` cannot speak RPC), as does the backfill POST stream; only their payload types (`DownloadStatus`, `UploadStatus`, `PhotoNewEvent`, `BothVariantsPayload`) now come from the contract, so the web app no longer re-declares them.
* **Change**: Effect gained a request-side seam — the download/archive domain runs behind one `ManagedRuntime` (`@vietz-dev/hono-effect`), reached via `runService(DownloadService, …)`, disposed during the SIGTERM drain. Plain CRUD stays plain async.

## 2026-09-20
* **Change**: The web app migrated to **Chakra UI v3** for components and layout, replacing inline styles and undeclared CSS variables. A single theme module now owns all colors, radii, fonts, shadows and gradients behind semantic token names; overlays share one dialog primitive; toasts moved to Chakra's toaster. Dark mode stays deferred but is now a one-file change. Updated [frontend](/architecture/frontend.md).

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

## 2026-07-11
* **Promotion**: [Download-Varianten](/decisions/download-variants.md) shipped — moved from `concepts/` to a Decision. Every event now always builds **two** archive variants, Kompakt (`DISPLAY`, from the display images) and Original (`ORIGINAL`), as two independent per-`quality` `DownloadJob`s. Kompakt is the guest default (opt-in Original); the Kompakt job is created lazily for pre-existing events.
* **Change**: `DownloadJob` gains `quality` with `@@unique([eventId, quality])`; parts inherit the variant; S3 archive keys gain a `{quality}-part-…` segment (legacy `gallery-part-…` = ORIGINAL). Updated [download jobs](/data-model/download-jobs.md), [storage](/architecture/storage.md).
* **Change**: The build trigger fans out over both variants (upload enqueues both; deletion stales both), the FIFO claim key is now `(event, quality)`, and the orphan sweep is variant-scoped. Updated [archive generation](/architecture/archive-generation.md).
* **Change**: `GET /api/gallery/:slug/download` returns both variants in one payload (Kompakt default); admin status/build-now/rebuild-all/cancel take a `?quality=` selector; the admin panel renders two per-variant panels and the guest page a Kompakt/Original toggle. Updated [gallery API](/api/gallery-api.md), [admin API](/api/admin-api.md).
