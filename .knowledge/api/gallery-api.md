---
type: API
title: Gallery API (Guest)
description: The guest-facing surface — unlock, browse, upload, and download, as oRPC procedures plus two SSE streams.
tags: [api, gallery, guest, orpc]
timestamp: 2026-09-24T00:00:00Z
---

# Transport

Every JSON call is an **oRPC procedure** declared in `@pixshar/contracts` and reached over `POST /api/rpc/gallery/<procedure>`; the browser calls them through the typed client (`apps/web/src/lib/rpc.ts`). Failures arrive as oRPC error codes (`NOT_FOUND`, `UNAUTHORIZED`, `TOO_MANY_REQUESTS`), never as English strings the client has to match. See [Contract-first API](/decisions/contract-first-api.md).

The two live feeds stay plain Hono SSE routes — an `EventSource` cannot speak RPC.

# Authentication

Every procedure except `gallery.info` and `gallery.unlock` runs behind the `galleryOs` middleware, which verifies the per-gallery JWT cookie **against the slug in the input**, so a session for one gallery cannot read another.

# Procedures

## `gallery.info({ slug })` — public
Returns `{ id, name, description }` for the password gate. Errors: `NOT_FOUND`.

## `gallery.unlock({ slug, password })` — public
Verifies the password, then sets the `gallery_{slug}` JWT cookie (`HttpOnly; SameSite=Lax`, 7 days) from inside the procedure via oRPC's response-headers plugin. Returns `{ success: true }`. Errors: `NOT_FOUND`, `UNAUTHORIZED`, `TOO_MANY_REQUESTS` (5 unlocks / 60 s per slug).

## `gallery.get({ slug })`
Returns `{ id, slug, name, description, photos: [{ id, photographerName, thumbUrl, displayUrl, status, placeholderDataUrl }] }` with presigned thumb/display URLs (1 h). Errors: `UNAUTHORIZED`, `TOO_MANY_REQUESTS`.

## `gallery.photoDownload({ slug, photoId })`
Returns `{ url }` — a presigned URL for the original with `Content-Disposition: attachment` baked into the signature.

## `gallery.upload.init({ slug, files, photographerName? })` / `gallery.upload.complete({ slug, photoIds })`
The guest half of the two-phase presigned upload. See [Upload API](/api/upload-api.md).

## `gallery.download({ slug })`
Returns **both** download variants in one payload — Kompakt (`DISPLAY`) and Original (`ORIGINAL`) — so the toggle can label both tabs from one round trip. Opening the page lazily creates the Kompakt job for events that predate the variant. See [Download-Varianten](/decisions/download-variants.md).

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

The default variant's fields are also spread at the top level. The payload shape is the contract's `bothVariantsPayload`, shared with the SSE stream below. Presigned part URLs expire after 1 hour and carry an attachment filename (Kompakt filenames get a `-kompakt` segment). This procedure runs through the Effect `DownloadService`.

# Streams (plain Hono, not RPC)

## GET /api/gallery/:slug/download/stream
`text/event-stream`. Pushes `download-status` events carrying the same `bothVariantsPayload`; any variant's status change re-emits the whole payload so both tabs stay live.

## GET /api/gallery/:slug/photos/stream
`text/event-stream`. Pushes a `photo-new` event (contract type `PhotoNewEvent`) whenever a photo finishes processing, so the guest grid fills in without a refresh.

Both live in `apps/api/src/routes/streams.ts`, authenticate with the same gallery cookie via the `requireGallerySession` Hono middleware, and ping `keep-alive` every 15 s.

# Citations

[1] [Auth architecture](/architecture/auth.md)
[2] [Upload API](/api/upload-api.md)
[3] [Archive generation architecture](/architecture/archive-generation.md)
[4] [Contract-first API](/decisions/contract-first-api.md)
