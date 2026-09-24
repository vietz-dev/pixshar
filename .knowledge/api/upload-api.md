---
type: API
title: Upload API
description: Two-phase presigned PUT flow for photo uploads from both admin and guests, as contract procedures.
tags: [api, upload, s3, presigned, orpc]
timestamp: 2026-09-24T00:00:00Z
---

# Design: Two-Phase Upload

Photos are **never uploaded through the API server**:

1. **Init** — the client sends metadata for a batch of files and gets one presigned `PUT` URL per fresh file.
2. **Put** — the browser uploads the bytes directly to S3 (4 in flight, `XMLHttpRequest` for progress).
3. **Complete** — the client reports which uploads landed, which enqueues processing.

So the API never receives image bytes: large files cannot exhaust its memory, and the bandwidth is browser ↔ S3.

# Procedures

Both halves are contract procedures; the limits (`MAX_FILE_SIZE` 50 MB, `ALLOWED_MIME_TYPES`) live in `@pixshar/contracts` and are re-used by the API's byte-level magic-number checks, so request validation and file validation cannot drift.

## `upload.init({ eventId, files, photographerName? })` — admin
`files` is an array of `{ fileName, ext, contentType, size, fileHash }`. The response is index-aligned: one `{ fileHash, duplicate, status, id, uploadUrl?, contentType? }` per requested file.

If `(eventId, fileHash)` already exists, the entry comes back `duplicate: true` with no row and no URL, and the client skips those bytes. Otherwise a Photo row is created with `status: PENDING` and `originalKey: {eventId}/originals/{photoId}.{ext}`, and a presigned `PUT` URL is issued for it (`Content-Type` enforced).

## `upload.complete({ eventId, photoIds })` — admin
Enqueues `photo-resize` via pg-boss for each photo and triggers the archive debounce.

## `upload.status({ eventId })` — admin
`{ pending, processed, failed, total }`. The UI reads it once and then follows the SSE stream.

## `gallery.upload.init` / `gallery.upload.complete` — guest
The same flow keyed by `slug` instead of `eventId`, behind the gallery session cookie. The photo is tagged `uploadedBy: GUEST` and appears in the gallery alongside admin uploads after processing.

# Authorisation

Admin procedures run under `adminOs` + `requireOwnedEvent`; guest procedures under `galleryOs`. Neither handler repeats the ownership check — it is declared at the procedure.

# Concurrency

The web client caps concurrent PUTs at 4. The API imposes no per-client limit; pg-boss throttles processing throughput via `WORKER_CONCURRENCY`.

# Citations

[1] [Gallery API](/api/gallery-api.md)
[2] [Admin API](/api/admin-api.md)
[3] [Storage architecture](/architecture/storage.md)
[4] [Presigned URLs decision](/decisions/presigned-urls.md)
