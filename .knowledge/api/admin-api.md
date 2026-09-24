---
type: API
title: Admin API
description: Admin-only oRPC procedures for event CRUD, photo management, processing status, and archive control.
tags: [api, admin, orpc]
timestamp: 2026-09-24T00:00:00Z
---

# Transport & Authentication

Admin JSON calls are **oRPC procedures** from `@pixshar/contracts`, reached over `POST /api/rpc/<path>` (see [Contract-first API](/decisions/contract-first-api.md)). They are built from the `adminOs` middleware, which asserts a BetterAuth session (`UNAUTHORIZED` otherwise), and most of them add `requireOwner`, which loads the event and raises `NOT_FOUND` / `FORBIDDEN` before the handler runs. Rate limits are declared per procedure with the `rateLimit` middleware.

There is exactly one admin account per installation; sign-up is disabled. `POST /api/auth/*` remains BetterAuth's own endpoint family (`sign-in/email`, `sign-out`, `get-session`) and is not part of the contract.

# Event Management

- `events.list()` — all events with `_count.photos`.
- `events.create({ name, slug, description?, password })` — slug must be unique and lowercase; `CONFLICT` on collision.
- `events.get({ id })` — full detail: the decrypted gallery password plus every photo with presigned thumb/display URLs.
- `events.setPassword({ id, password })`
- `events.delete({ id })` — deletes the event, its rows (cascade) and every S3 object under `{eventId}/`. Irreversible.

# Photos

- `events.photos.retry({ id })` — re-queues every FAILED photo of the event onto pg-boss, reusing the rows.
- `events.photos.rename({ id, photoIds, photographerName })` — bulk attribution; a blank name clears it.
- `events.photos.deleteMany({ id, photoIds })` / `events.photos.delete({ id, photoId })` — remove the rows and their S3 objects, then mark the archive parts that contained those photos `STALE` and reconcile both variants.
- `events.photoDownload({ id, photoId })` — presigned attachment URL for one original.

# Processing Status

- `upload.status({ eventId })` — `{ pending, processed, failed, total }` for the admin progress bar.
- `admin.backfillStatus()` — how many PROCESSED photos still lack a blur placeholder.

# Archive Control

Every archive procedure takes a `quality: "DISPLAY" | "ORIGINAL"` input (default `ORIGINAL`) and targets **one** variant; the admin UI renders two independent per-variant panels. See [Download-Varianten](/decisions/download-variants.md). All four run through the Effect `DownloadService` (`runService`), not directly against Prisma.

- `events.download.status({ id, quality })` — the variant's DownloadJob state with every progress field (`quality`, `totalPhotos`, `partCount`, `totalSizeBytes`, `debounceUntil`, `failureReason`); `status: "NONE"` when no job row exists yet.
- `events.download.buildNow({ id, quality })` — skips the debounce wait only; still routes QUEUED → FIFO claim. No-op if nothing is pending.
- `events.download.rebuildAll({ id, quality })` — marks every part `STALE` and regenerates its bytes from the stored membership (membership preserved).
- `events.download.cancel({ id, quality })` — cancels a QUEUED/BUILDING/DEBOUNCING job; committed parts stay downloadable.

# Non-RPC Routes

Four endpoints are deliberately not procedures:

| Route | Why |
|---|---|
| `GET /api/events/:id/download/status/stream?quality=` | SSE build progress, server-filtered by variant |
| `GET /api/upload/events/:id/photos/status/stream` | SSE `photo-status` + `photo-new` for one event |
| `POST /api/admin/backfill/start` | streams progress from a POST body — an `EventSource` cannot POST |
| `POST /api/auth/*` | owned by BetterAuth |

The SSE handlers live in `apps/api/src/routes/streams.ts` and their payload types (`DownloadStatus`, `UploadStatus`, `PhotoNewEvent`) come from the contract, so the web app never re-declares them.

# Citations

[1] [Gallery API](/api/gallery-api.md)
[2] [Upload API](/api/upload-api.md)
[3] [Auth architecture](/architecture/auth.md)
[4] [Contract-first API](/decisions/contract-first-api.md)
