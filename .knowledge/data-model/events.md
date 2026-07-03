---
type: Data Model
title: Event
description: The core gallery entity — a named, password-protected collection of photos.
tags: [data-model, event, gallery]
timestamp: 2026-07-03T00:00:00Z
---

# What an Event Is

An **Event** is the central entity in Pixshar. It represents one occasion (a wedding, a birthday, a corporate event) for which the photographer has set up a private gallery. Everything else — photos, archive jobs, gallery sessions — belongs to an event.

# Fields

| Field | Type | Description |
|---|---|---|
| `id` | String (cuid) | Internal unique identifier |
| `slug` | String (unique) | URL-safe identifier used in all public URLs (`/gallery/{slug}`) |
| `name` | String | Human-readable display name shown to guests |
| `description` | String? | Optional note displayed on the gallery cover page |
| `passwordHash` | String | bcrypt hash of the gallery password |
| `status` | Enum | `PROCESSING` or `READY` — reflects whether all uploaded photos have been processed |
| `createdById` | String | FK to the admin User who created the event |
| `createdAt` | DateTime | Creation timestamp |

# Slug Constraints

Slugs must be lowercase, URL-safe, and globally unique across the installation. The admin UI auto-generates slugs from the event name but allows manual override. Attempting to create two events with the same slug returns a `409 Conflict`.

# Event Status vs Photo Status

The event's `status` field is a coarse-grained flag:
- `PROCESSING` — at least one photo has status `PENDING` or `PROCESSING`
- `READY` — all photos are `PROCESSED` or `FAILED`

This is used to show the admin a simple "still processing" banner. Individual photo status is tracked separately on each [Photo](/data-model/photos.md) row.

# Lifecycle

1. Admin creates the event via `POST /api/events`.
2. Guests unlock the gallery by submitting the password to `POST /api/gallery/:slug/unlock`.
3. The event exists until explicitly deleted by the admin (`DELETE /api/events/:id`), which also deletes all photos from S3 and all associated DB rows via cascade.

# Citations

[1] [Photos data model](/data-model/photos.md)
[2] [Download Jobs data model](/data-model/download-jobs.md)
[3] [Admin API](/api/admin-api.md)
