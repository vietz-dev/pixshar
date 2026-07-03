---
type: API
title: Admin API
description: Admin-only endpoints for event CRUD, photo management, processing status, and archive control.
tags: [api, admin]
timestamp: 2026-07-03T00:00:00Z
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

## GET /api/events/:id/download/status
Returns the current DownloadJob state with all progress fields. Unlike the gallery-facing endpoint, this returns `totalPhotos`, `partCount`, `totalSizeBytes`, `debounceUntil`, and `failureReason` for the admin UI's detailed panel.

## POST /api/events/:id/download/build
Forces an immediate archive build (bypasses debounce). Cancels any in-progress build, resets the job to QUEUED, and signals the worker. Used from the admin event detail page's "Rebuild archive" button.

## POST /api/events/:id/download/cancel
Cancels a QUEUED or BUILDING job. Existing S3 parts are deleted; the job transitions to CANCELLED.

## GET /api/events/:id/download/stream
SSE stream for real-time archive build progress. Same payload as `GET /api/events/:id/download/status` but pushed on state changes.

# Auth Routes

`POST /api/auth/*` — BetterAuth's standard endpoint family: `sign-in/email`, `sign-out`, `get-session`. These are handled by BetterAuth's Hono integration and are not custom routes.

# Citations

[1] [Gallery API](/api/gallery-api.md)
[2] [Upload API](/api/upload-api.md)
[3] [Auth architecture](/architecture/auth.md)
