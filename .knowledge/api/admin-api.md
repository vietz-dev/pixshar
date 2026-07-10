---
type: API
title: Admin API
description: Admin-only endpoints for event CRUD, photo management, processing status, and archive control.
tags: [api, admin]
timestamp: 2026-07-11T00:00:00Z
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

Every action and status endpoint takes a `?quality=DISPLAY|ORIGINAL` selector (default `ORIGINAL`) and targets **one** variant. Each event has two archives (Kompakt / Original); the admin UI renders two independent per-variant panels. See [Download-Varianten](/decisions/download-variants.md).

## GET /api/events/:id/download/status?quality=…
Returns the selected variant's DownloadJob state with all progress fields. Unlike the gallery-facing endpoint, this returns `quality`, `totalPhotos`, `partCount`, `totalSizeBytes`, `debounceUntil`, and `failureReason` for the admin UI's detailed panel.

## POST /api/events/:id/download/build-now?quality=…
Skips the debounce wait and queues the pending reconcile immediately for that variant. Only the timer is skipped — it still routes through QUEUED → the FIFO claim. No-op if nothing is pending.

## POST /api/events/:id/download/rebuild-all?quality=…
Marks every part of that variant `STALE` and reconciles, regenerating each part's bytes from its stored membership (membership preserved, so guests aren't forced to re-download unchanged parts).

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
