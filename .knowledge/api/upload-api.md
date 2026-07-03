---
type: API
title: Upload API
description: Two-phase presigned PUT flow for photo uploads from both admin and guests.
tags: [api, upload, s3, presigned]
timestamp: 2026-07-03T00:00:00Z
---

# Design: Two-Phase Upload

Photos are **never uploaded through the API server**. Instead, the upload uses a two-phase flow:

1. **Init** — client calls the API to reserve a Photo row and get a presigned `PUT` URL.
2. **Put** — client uploads the file directly from browser to S3 using the presigned URL.
3. **Complete** — client notifies the API that the upload finished, triggering processing.

This means the API server never receives image bytes. Large files don't exhaust API server memory, and bandwidth is consumed only between browser and S3.

# Admin Upload Flow

## POST /api/upload/events/:id/photos/init
**Auth:** Admin session  
**Body:** `{ fileName, contentType, fileHash, fileSize }`  
**Response:** `{ photoId, uploadUrl, key, isDuplicate }`

If `(eventId, fileHash)` already exists, returns `{ isDuplicate: true, photoId }` without creating a new row or presigned URL.

Otherwise:
1. Creates a Photo row with `status: PENDING`, `originalKey: {eventId}/originals/{photoId}.{ext}`.
2. Generates a presigned `PUT` URL for `originalKey` (5-minute expiry, `Content-Type` enforced).
3. Returns the URL to the client.

## POST /api/upload/events/:id/photos/complete
**Auth:** Admin session  
**Body:** `{ photoId }`  
Enqueues `photo-resize` via pg-boss. Triggers archive debounce.

## GET /api/upload/events/:id/photos/status
**Auth:** Admin session  
**Response:** `{ total, pending, processing, processed, failed }`  
Polled by the admin UI every 2 s while `pending > 0`.

# Guest Upload Flow

Guest uploads follow the same two-phase pattern, accessed through gallery endpoints:

- `POST /api/gallery/:slug/upload/init` — same as admin init, but requires gallery cookie and mandates `photographerName`.
- `POST /api/gallery/:slug/upload/complete` — same as admin complete, requires gallery cookie.

The photo is tagged `uploadedBy: GUEST` and appears in the gallery alongside admin-uploaded photos after processing.

# Concurrency

The admin UI caps concurrent uploads at 4 simultaneous presigned PUT requests. The API imposes no per-client concurrency limit but pg-boss naturally throttles processing throughput via `WORKER_CONCURRENCY`.

# Citations

[1] [Gallery API](/api/gallery-api.md)
[2] [Admin API](/api/admin-api.md)
[3] [Storage architecture](/architecture/storage.md)
[4] [Presigned URLs decision](/decisions/presigned-urls.md)
