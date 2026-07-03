---
type: Data Model
title: Download Jobs
description: DownloadJob state machine and DownloadArchivePart tracking for multi-part ZIP archives.
tags: [data-model, download, archive, zip]
timestamp: 2026-07-03T00:00:00Z
---

# Two Tables

The archive download feature uses two tables:

## DownloadJob

One row per event (at most). Tracks the overall state of the archive build.

| Field | Type | Description |
|---|---|---|
| `id` | String (cuid) | Unique job ID |
| `eventId` | String (unique) | FK to Event — one job per event at most |
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

## DownloadArchivePart

One row per archive part within a completed (or in-progress) build.

| Field | Type | Description |
|---|---|---|
| `id` | String (cuid) | Unique part ID |
| `jobId` | String | FK to DownloadJob (CASCADE on delete) |
| `partIndex` | Int | 1-based part number |
| `key` | String | S3 key for the part ZIP file |
| `sizeBytes` | BigInt | Size of the part in bytes |
| `createdAt` | DateTime | When the part was committed to S3 |

The `(jobId, partIndex)` pair has a unique constraint.

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

Parts are inserted into `DownloadArchivePart` **one at a time** as each part upload to S3 completes. This means partial progress is recoverable if the worker crashes partway through: the reaper detects the stale build, deletes all existing part rows and S3 objects under `{eventId}/archive/`, and restarts from scratch.

# Citations

[1] [Archive generation architecture](/architecture/archive-generation.md)
[2] [Multi-part archive decision](/decisions/multi-part-archive.md)
[3] [Photos data model](/data-model/photos.md)
