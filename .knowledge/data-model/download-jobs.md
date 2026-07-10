---
type: Data Model
title: Download Jobs
description: DownloadJob state machine and DownloadArchivePart tracking for multi-part ZIP archives.
tags: [data-model, download, archive, zip, quality]
timestamp: 2026-07-11T00:00:00Z
---

# Two Tables

The archive download feature uses two tables:

## DownloadJob

One row per **(event, variant)** — at most two per event, one for each
`ArchiveQuality` (`DISPLAY` = Kompakt, `ORIGINAL`). Each variant is an
independently claimable build. See [Download-Varianten](/decisions/download-variants.md).

| Field | Type | Description |
|---|---|---|
| `id` | String (cuid) | Unique job ID |
| `eventId` | String | FK to Event |
| `quality` | Enum | `DISPLAY` \| `ORIGINAL` (default `ORIGINAL`). Selects the S3 source objects the build zips (display images vs. originals) |
| `status` | Enum | State machine status (see below) |
| `photoCount` | Int | Number of photos counted when the build started |
| `processedPhotos` | Int | Photos packed so far (updated during build for progress reporting) |
| `uploadProgress` | Float | 0–100, reflects S3 multipart upload progress within current part |
| `totalPhotos` | Int | Total PROCESSED photos in the event at build time |
| `totalSizeBytes` | BigInt? | Sum of all parts' sizes once READY |
| `partCount` | Int | Number of archive parts (updated after planning, before streaming) |
| `queuedAt` | DateTime? | When the job entered QUEUED state (used for FIFO ordering across replicas) |
| `debounceUntil` | DateTime? | When the current debounce window expires |
| `claimedAt` | DateTime? | When the current worker replica claimed the build lease |
| `claimedBy` | String? | Hostname of the replica holding the build lease |
| `heartbeatAt` | DateTime? | Updated every few photos; stale value triggers crash recovery reaper |
| `attempts` | Int | Build attempt count |
| `lastError` | String? | Last failure reason |
| `failureReason` | String? | Terminal failure reason |
| `updatedAt` | DateTime | Last update timestamp |

`@@unique([eventId, quality])` — the compound key allows the two variants to
coexist as separate rows. Existing pre-variant rows migrate to `ORIGINAL` (the
old builder zipped originals), so no data rewrite is needed.

## DownloadArchivePart

One **long-lived, immutable** row per archive part. Parts are no longer wiped on each build — they persist across builds and are only appended to (new parts) or rebuilt in place (on deletion). A part has **no** `quality` column: it inherits its variant from the parent `DownloadJob`.

| Field | Type | Description |
|---|---|---|
| `id` | String (cuid) | Unique part ID |
| `jobId` | String | FK to DownloadJob (CASCADE on delete) |
| `partIndex` | Int | 1-based part number; stable identity, never renumbered (gaps allowed) |
| `key` | String | Versioned, variant-scoped S3 key (`…/archive/{quality}-part-{index}-g{generation}.zip`) |
| `sizeBytes` | BigInt | Size of the part in bytes |
| `status` | String | `READY` (immutable) or `STALE` (queued for in-place rebuild after a deletion / rebuild-all) |
| `membershipSig` | String | sha1 of sorted photoId list — content identity for guest download-tracking |
| `generation` | Int | Bumped on each physical rebuild; feeds the versioned S3 key |
| `photoCount` | Int | Number of photos in the part |
| `createdAt` / `updatedAt` | DateTime | Timestamps |

The `(jobId, partIndex)` pair has a unique constraint.

## DownloadArchivePartEntry

Durable membership: which photos belong to which part. One row per (part, photo).

| Field | Type | Description |
|---|---|---|
| `id` | String (cuid) | Unique row ID |
| `partId` | String | FK to DownloadArchivePart (CASCADE on delete) |
| `photoId` | String | Photo id — **no FK to Photo** (a deleted photo's membership row must survive until the reconcile reads it) |

`@@unique([partId, photoId])` + `@@index([photoId])` (the index powers the "which parts contain this deleted photo?" lookup).

# DownloadJob State Machine

```
DEBOUNCING → QUEUED → BUILDING → READY
                              ↘ FAILED
                              ↘ CANCELLED
```

| Status | Meaning |
|---|---|
| `DEBOUNCING` | Waiting for upload activity to settle before queuing |
| `QUEUED` | Ready to be claimed by a worker |
| `BUILDING` | Actively being built by one worker replica |
| `READY` | All parts committed to S3; `DownloadArchivePart` rows populated |
| `FAILED` | Build failed after max attempts |
| `CANCELLED` | Cancelled by the admin (e.g. before a force-rebuild) |

# Part Lifecycle

Parts are committed to `DownloadArchivePart` **one at a time** as each part upload to S3 completes. Recovery is incremental: immutable `READY` parts are kept, so a crash only redoes the in-flight new/rebuilt part. A crashed rebuild leaves the part `STALE` (its previous-generation object still serving) for the next reconcile to retry. A per-build orphan sweep removes archive objects not referenced by a live part.

# Citations

[1] [Archive generation architecture](/architecture/archive-generation.md)
[2] [Multi-part archive decision](/decisions/multi-part-archive.md)
[3] [Photos data model](/data-model/photos.md)
