---
type: API
title: Admin API
description: Admin-only endpoints for event CRUD, photo management, processing status, and archive control — including pre-warming a lazily-built archive and releasing one early.
tags: [api, admin, archive, expiry]
timestamp: 2026-07-12T00:00:00Z
---

# Authentication

All admin endpoints require a valid BetterAuth session cookie obtained via `POST /api/auth/sign-in/email`. There is exactly one admin account per installation; sign-up is disabled.

# Event Management

## GET /api/events
Returns an array of all events with summary info (id, slug, name, status, photo counts, download job status).

## POST /api/events
**Body:** `{ name, slug, password, description? }`  
Creates a new event. Slug must be unique and lowercase. Returns `409` on slug conflict.

## GET /api/events/:id
Returns full event details including all photos (with presigned URLs for admin view) and the current download job state.

## DELETE /api/events/:id
Deletes the event, all its photos, all S3 objects under `{eventId}/`, and all associated DB rows (cascade). This is irreversible.

# Processing Status & SSE

## GET /api/upload/events/:id/photos/status
Returns current counts: `{ total, pending, processing, processed, failed }`. Used for the admin progress bar.

## GET /api/events/:id/status/stream
SSE stream that pushes photo processing progress and archive build status updates as they occur. Powered by the `pg_notify` bridge — the image-processor sends notifications; the API relays them over SSE.

# Archive Control

Every action and status endpoint takes a `?quality=DISPLAY|ORIGINAL` selector (default `ORIGINAL`) and targets **one** variant. Each event can have up to two archives (Kompakt / Original); the admin UI renders two independent per-variant panels. Archives are built lazily — nothing is built until a guest or admin explicitly asks — and idle-expired after `DOWNLOAD_ARCHIVE_TTL_DAYS`; see [Download-Varianten](/decisions/download-variants.md) and [Archiv-Lebenszeit](/decisions/archive-lifetime.md).

## GET /api/events/:id/download/status?quality=…
Returns the selected variant's DownloadJob state with all progress fields. Unlike the gallery-facing endpoint, this returns `quality`, `totalPhotos`, `partCount`, `totalSizeBytes`, `debounceUntil`, and `failureReason` for the admin UI's detailed panel. Also returns the idle-clock fields: `lastDownloadedAt`, `readyAt`, `expiredAt`, and `expiresAt` — a derived countdown to when the archive will be reclaimed if nobody downloads it (`null` when not `READY`, or when `DOWNLOAD_ARCHIVE_TTL_DAYS=0` disables expiry).

## POST /api/events/:id/download/build-now?quality=…
Skips the debounce wait and queues the pending reconcile immediately for that variant. Doubles as the **pre-warm** action: unlike the gallery-facing request endpoint, this also works from `NONE` or `EXPIRED`, creating the job if one doesn't exist yet — so an admin can have an archive ready before sharing the gallery link, or restore an idle-expired one on demand. Only the debounce timer is skipped otherwise — it still routes through QUEUED → the FIFO claim.

## POST /api/events/:id/download/rebuild-all?quality=…
Marks every part of that variant `STALE` and reconciles, regenerating each part's bytes from its stored membership (membership preserved, so guests aren't forced to re-download unchanged parts).

## POST /api/events/:id/download/release?quality=…
Reclaims this variant's S3 objects immediately instead of waiting for the idle reaper — the same `expireArchive` effect the periodic reaper runs, so there is exactly one reclamation code path exercised both on a timer and over HTTP. The membership (job + parts) survives, so the next request rebuilds identical parts. Returns `{ success: true, released: boolean }`; `released: false` means the variant wasn't `READY` (nothing to reclaim).

## POST /api/events/:id/download/cancel?quality=…
Cancels a QUEUED/BUILDING/DEBOUNCING job for that variant. Already-committed (immutable) parts stay downloadable; a pending rebuild reverts to READY.

## GET /api/events/:id/download/status/stream?quality=…
SSE stream for real-time build progress of the selected variant (server-filtered by `quality`), pushed on state changes.

# Auth Routes

`POST /api/auth/*` — BetterAuth's standard endpoint family: `sign-in/email`, `sign-out`, `get-session`. These are handled by BetterAuth's Hono integration and are not custom routes.

# Citations

[1] [Gallery API](/api/gallery-api.md)
[2] [Upload API](/api/upload-api.md)
[3] [Auth architecture](/architecture/auth.md)
[4] [Archiv-Lebenszeit decision](/decisions/archive-lifetime.md)
