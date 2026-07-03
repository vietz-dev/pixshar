---
type: Data Model
title: Photo
description: A single photo in an event gallery — tracks upload source, S3 keys, processing status, and deduplication.
tags: [data-model, photo, processing]
timestamp: 2026-07-03T00:00:00Z
---

# What a Photo Row Represents

A `Photo` row is created the moment an upload is initiated (not after it completes). The row is the **job record** for the image processing queue as well as the persistent representation of the photo in the gallery. This dual role means the DB is always the source of truth for what has been uploaded, regardless of S3 state.

# Fields

| Field | Type | Description |
|---|---|---|
| `id` | String (cuid) | Unique photo identifier |
| `eventId` | String | FK to parent Event |
| `photographerName` | String? | Name provided at upload time (required for guests, optional for admin) |
| `originalKey` | String | S3 key for the as-uploaded original |
| `displayKey` | String? | S3 key for the 1920 px display variant (set after processing) |
| `thumbKey` | String? | S3 key for the 400 px thumbnail (set after processing) |
| `sizeBytes` | Int? | File size of the display variant in bytes (set after processing, used for archive planning) |
| `fileHash` | String? | SHA-256 of the original upload (used for deduplication) |
| `status` | Enum | Current processing state (see below) |
| `uploadedBy` | Enum | `ADMIN` or `GUEST` |
| `attempts` | Int | Number of processing attempts made |
| `lastError` | String? | Last error message if processing failed |
| `nextAttemptAt` | DateTime? | Earliest time for the next processing attempt |
| `createdAt` | DateTime | Upload initiation timestamp |

# Processing Status

```
PENDING → PROCESSING → PROCESSED
                    ↘ FAILED
```

| Status | Meaning |
|---|---|
| `PENDING` | Uploaded to S3, job enqueued but not yet started |
| `PROCESSING` | Worker has claimed the job |
| `PROCESSED` | Both display and thumb variants exist in S3; `displayKey`, `thumbKey`, `sizeBytes` are set |
| `FAILED` | Max attempts exhausted or terminal error (e.g. not a valid image file) |

# Deduplication

The `(eventId, fileHash)` pair has a unique constraint. If a guest or admin uploads the same file twice, the second `POST` returns the existing Photo row rather than creating a duplicate or re-processing.

# What Gets Stored in S3

For each photo, up to three objects exist:
- `{eventId}/originals/{photoId}.{ext}` — the original, kept for archival
- `{eventId}/display/{photoId}.jpg` — 1920 px, shown in the lightbox
- `{eventId}/thumbs/{photoId}.jpg` — 400 px, shown in the grid

Only `PROCESSED` photos are included in the download archive.

# Citations

[1] [Events data model](/data-model/events.md)
[2] [Image processing architecture](/architecture/image-processing.md)
[3] [Upload API](/api/upload-api.md)
