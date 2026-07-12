---
type: API
title: Gallery API (Guest)
description: The guest-facing HTTP surface — unlock, browse, upload, and download. Archive builds are lazy (guest-requested); part links are measured downloads.
tags: [api, gallery, guest, archive, expiry]
timestamp: 2026-07-12T00:00:00Z
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

Returns **both** download variants in a single response — Kompakt (`DISPLAY`) and Original (`ORIGINAL`) — so the toggle can label both tabs from one round trip. This is a **pure read**: it creates no `DownloadJob` and starts no build, for either variant. A variant with no archive (never requested, or idle-expired) reports `status: "NONE"` or `"EXPIRED"`; the guest asks for it explicitly via `POST /download/request`. See [Download-Varianten](/decisions/download-variants.md) and [Archiv-Lebenszeit](/decisions/archive-lifetime.md).

```json
{
  "defaultQuality": "DISPLAY",
  "variants": {
    "DISPLAY":  { "status": "READY", "photoCount": 42, "partCount": 3, "totalSizeBytes": 734003200, "building": false, "parts": [ { "index": 1, "url": "/api/gallery/my-slug/download/part/1?quality=DISPLAY", "sizeBytes": 268435456, "membershipSig": "…", "rebuilding": false } ] },
    "ORIGINAL": { "status": "NONE", "photoCount": 42, "partCount": 0, "totalSizeBytes": 0, "building": false, "parts": [] }
  },
  "status": "READY", "parts": [ … ]
}
```

Each variant carries the per-status fields (`status` ∈ `READY | BUILDING | DEBOUNCING | QUEUED | NONE | EXPIRED`, `parts[]`, `partCount`, `totalSizeBytes`, `photoCount`, `building`). The default variant's fields are also spread at the top level for backward compatibility. A part's `url` is **not** a presigned S3 URL — it points at `GET /download/part/:index`, below, which is what actually measures a download.

---

## POST /api/gallery/:slug/download/request

**Auth:** Gallery cookie (rate-limited: 20/min per gallery)  
**Query:** `?quality=DISPLAY|ORIGINAL` (default `DISPLAY`)  
**Response:** `{ success: true, quality, queued: boolean, status }`

The **only** guest action that spends S3 bytes on a build. Queues a build for the selected variant if it is `NONE`, `EXPIRED`, or `FAILED`; a no-op (`queued: false`) if the variant is already `READY` or a build is already pending — so a guest hammering the "Archiv erstellen" button cannot stack builds. This is the single entry point (`requestBuild`) that ever creates a `DownloadJob`.

---

## GET /api/gallery/:slug/download/part/:index

**Auth:** Gallery cookie (rate-limited: 60/min per gallery)  
**Query:** `?quality=DISPLAY|ORIGINAL` (default `DISPLAY`)  
**Response:** `302` redirect to a freshly presigned S3 URL (15-minute expiry), or `404` if the part has no live object

The measured download. Every part link in the payload above points here, not at S3 directly — this is the only place the API learns a guest actually pulled bytes. Before redirecting, it stamps the (event, variant) job's `lastDownloadedAt`, which is the idle clock [Archiv-Lebenszeit](/decisions/archive-lifetime.md) reads to decide when to reclaim the archive's S3 objects. Bytes still stream directly from S3 — see [Presigned URLs](/decisions/presigned-urls.md).

---

## GET /api/gallery/:slug/download/stream

**Auth:** Gallery cookie  
**Response:** `text/event-stream` (SSE)

Pushes `download-status` events matching the same both-variants payload shape as `GET /download`; any variant's status change re-emits the whole payload so both tabs stay live. Used by the gallery view page and the download page.

# Citations

[1] [Auth architecture](/architecture/auth.md)
[2] [Upload API](/api/upload-api.md)
[3] [Archive generation architecture](/architecture/archive-generation.md)
[4] [Archiv-Lebenszeit decision](/decisions/archive-lifetime.md)
