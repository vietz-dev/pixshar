---
type: Decision
title: Multi-part archive generation
description: Large galleries are split into ≤2 GB ZIP parts, streamed to S3 with bounded memory, built one at a time per worker process.
tags: [decision, archive, zip, streaming, memory]
timestamp: 2026-07-03T00:00:00Z
---

# Decision

When building the download archive, three constraints are enforced simultaneously:

1. **Part size cap** (`DOWNLOAD_MAX_PART_BYTES`, default 2 GB): No single ZIP file exceeds this limit.
2. **Bounded memory**: The worker streams photos from S3 through archiver into a multipart S3 upload. Peak RAM usage is ~32 MB regardless of gallery size.
3. **Serial per-process**: Only one archive build runs at a time within a worker process.

# Why Part Size Cap

**Resumable downloads:** If a guest's download is interrupted halfway through a 15 GB gallery archive, they lose that entire download. With 2 GB parts, a failure loses at most one part. Most operating systems and browsers handle re-downloading a single part without issue.

**Browser compatibility:** Some older browsers and download managers have issues with single files over ~4 GB (FAT32 file size limit, 32-bit size fields in some ZIP implementations). 2 GB parts stay well clear of these limits.

**S3 multipart upload limits:** S3 allows a maximum of 10,000 parts per multipart upload, each 5 MB–5 GB. Splitting archives into ≤2 GB files means each archive part is itself a single-upload object (no nested multipart), simplifying the implementation.

# Why Streaming (Not Buffering)

A naïve approach would download all photos to disk, zip them, and upload the result. This requires disk space proportional to the total gallery size twice (once for photos, once for the ZIP). A worker container does not have guaranteed local disk of that magnitude.

Instead:
- Photos are fetched from S3 one at a time using `GetObjectCommand` (streaming, backpressured).
- `archiver` (ZIP, store mode — no compression) receives each photo as a stream.
- `archiver`'s output pipe feeds an `@aws-sdk/lib-storage` `Upload` with `partSize: 16 MB, queueSize: 2`.
- Peak memory is ~32 MB (two 16 MB upload buffers) + one in-flight S3 download stream.

No compression (`store: true`) is intentional: JPEGs are already compressed. Applying ZIP deflate would use significant CPU time and reduce file size by less than 1%, while complicating the streaming pipeline.

# Why Serial Builds Per Process

Archive builds are I/O-heavy (many S3 reads and writes) but not CPU-heavy. Running two builds concurrently in one process would double S3 API calls and double peak memory (two 32 MB windows). The marginal throughput gain is small while the risk of OOM is real.

Multiple worker replicas can build different events in parallel — the per-event CAS claim ensures no event is double-built. Horizontal scaling is the right lever for throughput; per-process concurrency is the right lever for memory.

# Why Not ZIP64 / Single File

ZIP64 supports files and archives larger than 4 GB and is widely supported. However, it does not address the download-resumability problem — a guest's connection drop at 90% of a 15 GB download is still a full re-download. Multi-part archives solve this at the application layer with no special tooling on the guest's side.

# Download UX Consequence

The split-archive model changes the guest download UX: instead of one button triggering one file download, a dedicated page lists each part with a checkbox that turns green after clicking. This was judged acceptable: guests who need to download large galleries (thousands of photos) are by definition downloading many files and expect some management overhead.

# Citations

[1] [Archive generation architecture](/architecture/archive-generation.md)
[2] [Download Jobs data model](/data-model/download-jobs.md)
[3] [Durable queue decision](/decisions/durable-queue.md)
