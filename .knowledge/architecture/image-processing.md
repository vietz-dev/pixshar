---
type: Architecture
title: Image Processing
description: Durable pg-boss queue for photo resize; worker runs in a separate container.
tags: [image-processing, queue, worker, pg-boss]
timestamp: 2026-07-03T00:00:00Z
---

# Responsibility Split

Image processing happens entirely in the **image-processor** container, not in the API. After a photo upload completes (the browser calls the "complete upload" endpoint), the API enqueues a `photo-resize` job and returns immediately. The worker container picks up the job and does the heavy work.

# Queue: pg-boss

**pg-boss** is a PostgreSQL-backed job queue. It was chosen because Postgres is already a hard dependency, so it adds no new infrastructure. Features used:

- **`batchSize`** — the worker consumes up to `WORKER_CONCURRENCY` (default 2) jobs at a time, running them with `Promise.all`.
- **Built-in retry** — pg-boss retries failed jobs up to `PROCESS_MAX_ATTEMPTS` times (default 4) with exponential backoff. The worker differentiates terminal failures (invalid image, exhausted retries) from transient ones.
- **Deduplication** — `fileHash` (SHA-256 of the upload) is stored on the Photo row with a composite unique constraint on `(eventId, fileHash)`. A duplicate upload returns the existing photo without re-enqueuing.

# Photo Status Lifecycle

```
PENDING → PROCESSING → PROCESSED
                    ↘ FAILED
```

| Status | Meaning |
|---|---|
| `PENDING` | Job enqueued, not yet started |
| `PROCESSING` | Worker has claimed the job |
| `PROCESSED` | Resize complete, display and thumb keys set |
| `FAILED` | Terminal error (invalid image or max attempts exhausted) |

# Resize Steps

For each photo the worker:
1. Downloads the original from S3 (`{eventId}/originals/`).
2. Validates it is a readable image.
3. Resizes in parallel to 1920 px (display) and 400 px (thumb) using Bun's native image API.
4. Uploads both variants to S3 (`{eventId}/display/`, `{eventId}/thumbs/`).
5. Updates the Photo row (`status: PROCESSED`, sets `displayKey`, `thumbKey`, `sizeBytes`).
6. Emits a `pg_notify` so the API's SSE streams push an update to watching clients.
7. Triggers the archive debounce (see [Archive Generation](/architecture/archive-generation.md)).

# Multi-Replica Safety

Multiple image-processor replicas can run simultaneously. pg-boss's `FOR UPDATE SKIP LOCKED` ensures each job is claimed by exactly one worker. The `WORKER_CONCURRENCY` env var controls per-replica parallelism.

# Citations

[1] [pg-boss documentation](https://github.com/timgit/pg-boss)
[2] [Archive debounce trigger](/architecture/archive-generation.md)
[3] [Durable queue decision](/decisions/durable-queue.md)
