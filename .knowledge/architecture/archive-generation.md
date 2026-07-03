---
type: Architecture
title: Archive Generation
description: Streaming multi-part ZIP build with per-process FIFO serialization and a DB-backed state machine.
tags: [archive, zip, download, streaming, queue]
timestamp: 2026-07-03T00:00:00Z
---

# Purpose

When guests download a gallery they receive a ZIP archive containing all PROCESSED photos. Because galleries can be large (10 GB+), the archive is:
1. **Streamed** — never fully buffered in memory; built incrementally and uploaded to S3 in multipart chunks.
2. **Split into parts** — each part is at most `DOWNLOAD_MAX_PART_BYTES` (default 2 GB), so an interrupted download loses only one part.

# Trigger: Debounce

After every successful photo processing step, a debounce timer is reset. Once uploads have been quiet for `DOWNLOAD_DEBOUNCE_SECONDS` (default 60 s), the archive build is queued. A hard ceiling (`DOWNLOAD_MAX_WAIT_SECONDS`, default 120 s) prevents continuous uploads from starving the build indefinitely.

# State Machine: DownloadJob

```
DEBOUNCING → QUEUED → BUILDING → READY
                              ↘ FAILED
                              ↘ CANCELLED
```

All transitions use atomic `updateMany` with a `WHERE status = <expected>` guard, so concurrent worker replicas can never double-build the same event's archive.

# Part Planning

Before streaming, the worker performs a **greedy fill** pass over all PROCESSED photos (ordered by `createdAt`). It estimates each entry's size using the photo's stored `sizeBytes` plus a per-entry overhead constant for ZIP bookkeeping (headers, central directory). When adding the next photo would push the current part over the effective limit, a new part is started. A single photo larger than the limit gets its own oversized part — files cannot be split across archives.

# Streaming Pipeline

For each planned part:
1. An `archiver` instance (ZIP, store mode — no compression, since photos are already compressed JPEGs) pipes into a Node.js `PassThrough` stream.
2. The `PassThrough` feeds into an `@aws-sdk/lib-storage` multipart `Upload` (16 MB parts, 2-chunk queue — bounds peak memory to ~32 MB regardless of gallery size).
3. Photos are fetched from S3 one at a time via `GetObjectCommand` and appended to the archiver with backpressure. The S3 body stream is a Node.js `Readable`; archiver reads it and the PassThrough drains it.
4. After the last photo, `archive.finalize()` closes the ZIP and the multipart upload completes.
5. A `HeadObjectCommand` retrieves the final part size, and a `DownloadArchivePart` row is inserted.

Peak memory per build: ~32 MB of upload buffer + one S3 photo stream in flight at a time.

# Per-Process Serialization (FIFO)

Within a single image-processor process, at most **one archive build runs at a time**. This is enforced by a promise-chain mutex: each call to `runBuildZip` appends to a `buildChain` promise and is deduped by event ID. Multiple pending events queue FIFO (oldest `queuedAt` first).

Multiple worker replicas can build different events concurrently — each replica runs its own FIFO chain, and the per-event `QUEUED → BUILDING` CAS claim ensures no event is built by two replicas simultaneously.

# Crash Recovery

A heartbeat (`heartbeatAt`) is updated every few photos. A reaper (runs every `DOWNLOAD_BUILD_LEASE_SECONDS / 2`) detects BUILDING rows whose heartbeat is stale and resets them to QUEUED. On retry, stale S3 parts are deleted and the build restarts from scratch.

# Download UX

When a guest clicks the download button:
- **Single part**: a direct `<a download>` link.
- **Multiple parts**: the button navigates to `/gallery/[slug]/download`, a dedicated page that lists each part with a checkbox. Clicking a part link marks it downloaded in `localStorage`; the checkbox turns green. State persists across page reloads.

# Citations

[1] [Multi-part archive decision](/decisions/multi-part-archive.md)
[2] [Download Jobs data model](/data-model/download-jobs.md)
[3] [Durable queue decision](/decisions/durable-queue.md)
