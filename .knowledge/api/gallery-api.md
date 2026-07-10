---
type: API
title: Gallery API (Guest)
description: The guest-facing HTTP surface — unlock, browse, upload, and download.
tags: [api, gallery, guest]
timestamp: 2026-07-11T00:00:00Z
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
**Response:** Both-variants download payload

Returns **both** download variants in a single response — Kompakt (`DISPLAY`) and Original (`ORIGINAL`) — so the toggle can label both tabs from one round trip. Opening the page lazily creates the Kompakt job for events that predate the variant. See [Download-Varianten](/decisions/download-variants.md).

```json
{
  "defaultQuality": "DISPLAY",
  "variants": {
    "DISPLAY":  { "status": "READY", "photoCount": 42, "partCount": 3, "totalSizeBytes": 734003200, "building": false, "parts": [ { "index": 1, "url": "https://...", "sizeBytes": 268435456, "membershipSig": "…", "rebuilding": false } ] },
    "ORIGINAL": { "status": "BUILDING", "photoCount": 42, "partCount": 0, "totalSizeBytes": 0, "building": true, "parts": [] }
  },
  "status": "READY", "parts": [ … ]
}
```

Each variant carries the per-status fields (`status` ∈ `READY | BUILDING | DEBOUNCING | QUEUED | NONE`, `parts[]`, `partCount`, `totalSizeBytes`, `photoCount`, `building`). The default variant's fields are also spread at the top level for backward compatibility. Presigned part URLs expire after 1 hour and include a `Content-Disposition: attachment; filename="..."` header (Kompakt filenames carry a `-kompakt` segment).

---

## GET /api/gallery/:slug/download/stream

**Auth:** Gallery cookie  
**Response:** `text/event-stream` (SSE)

Pushes `download-status` events matching the same both-variants payload shape as `GET /download`; any variant's status change re-emits the whole payload so both tabs stay live. Used by the gallery view page and the download page.

# Citations

[1] [Auth architecture](/architecture/auth.md)
[2] [Upload API](/api/upload-api.md)
[3] [Archive generation architecture](/architecture/archive-generation.md)
