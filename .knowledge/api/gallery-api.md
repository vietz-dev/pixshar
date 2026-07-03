---
type: API
title: Gallery API (Guest)
description: The guest-facing HTTP surface — unlock, browse, upload, and download.
tags: [api, gallery, guest]
timestamp: 2026-07-03T00:00:00Z
---

# Authentication

All gallery endpoints (except `POST /unlock`) require a valid per-gallery JWT cookie set by the unlock endpoint. The cookie is scoped to a single event slug. Cross-gallery cookies are explicitly rejected.

# Endpoints

## POST /api/gallery/:slug/unlock

**Auth:** Public  
**Body:** `{ password: string }`  
**Response:** `{ success: true }` + sets `gallery_{slug}` cookie

Verifies the gallery password (bcrypt compare against the stored hash). On success, signs a JWT scoped to the event ID and sets it as an `HttpOnly; SameSite=Lax` cookie. Redirecting to `/gallery/{slug}/view` is done by the frontend, not the API.

On failure: `401 { error: "Invalid password" }`.

---

## GET /api/gallery/:slug

**Auth:** Gallery cookie  
**Response:** `{ id, slug, name, description, photos: [{id, photographerName, thumbUrl, displayUrl, status, placeholderDataUrl}] }`

Returns event metadata and all photos with presigned thumb and display URLs. Only `PROCESSED` photos have valid URLs. `PENDING`/`PROCESSING` photos are included with their status so the frontend can show a "processing" placeholder. URLs expire after 15 minutes.

---

## POST /api/gallery/:slug/upload/init

**Auth:** Gallery cookie  
**Body:** `{ fileName: string, contentType: string, fileHash: string, fileSize: number, photographerName: string }`  
**Response:** `{ photoId, uploadUrl, isDuplicate }` or `{ isDuplicate: true, photoId }` on dedup

Creates a Photo row (`status: PENDING`), generates a presigned `PUT` URL (5-minute expiry), and returns it. The client uploads directly to S3 using this URL, then calls the complete endpoint.

---

## POST /api/gallery/:slug/upload/complete

**Auth:** Gallery cookie  
**Body:** `{ photoId: string }`

Confirms the S3 upload completed. Enqueues the `photo-resize` job. Triggers archive debounce.

---

## GET /api/gallery/:slug/download

**Auth:** Gallery cookie  
**Response:** Download payload (varies by status)

When `status = "READY"`:
```json
{
  "status": "READY",
  "photoCount": 42,
  "partCount": 3,
  "totalSizeBytes": 5368709120,
  "parts": [
    { "index": 1, "url": "https://...", "sizeBytes": 2147483648 },
    { "index": 2, "url": "https://...", "sizeBytes": 2147483648 },
    { "index": 3, "url": "https://...", "sizeBytes": 1073741824 }
  ]
}
```

For non-READY states: `{ "status": "BUILDING" | "DEBOUNCING" | "QUEUED" | "NONE", ... }`.

Presigned part URLs expire after 1 hour and include a `Content-Disposition: attachment; filename="..."` header.

---

## GET /api/gallery/:slug/download/stream

**Auth:** Gallery cookie  
**Response:** `text/event-stream` (SSE)

Pushes `download-status` events matching the same payload shape as `GET /download`. The stream closes when status reaches `READY` or `FAILED`. Used by the gallery view page to show live archive build progress in the download button.

# Citations

[1] [Auth architecture](/architecture/auth.md)
[2] [Upload API](/api/upload-api.md)
[3] [Archive generation architecture](/architecture/archive-generation.md)
