---
type: Concept
title: ZIP TTL — lazy archive generation with S3 expiry
description: Future concept for reducing storage costs in hosted SaaS by expiring ZIP archives after inactivity and rebuilding on demand.
tags: [concept, future, zip, ttl, storage, saas, archive, cost]
status: future — not yet implemented
timestamp: 2026-07-05T00:00:00Z
---

# Concept

In a self-hosted deployment archives are built once and kept indefinitely — this is correct
because the operator controls costs directly. In a hosted multi-tenant SaaS context, storing
archives permanently is expensive because JPEG ZIPs barely compress (ratio ~1:1), so the
archive doubles the effective storage footprint of every event.

The proposed solution: **archives are ephemeral**. S3 lifecycle rules expire them after a TTL.
On the next download request after expiry the system rebuilds them transparently.

This concept is not yet implemented. It is recorded here so the current architecture is not
accidentally simplified or broken before this is built.

# Why ZIPs Are Expensive

JPEG files are already compressed. A ZIP of 10 GB of photos occupies ~9.8 GB on S3 — near-zero
gain. For the current multi-part model (see [Archive Generation](/architecture/archive-generation.md)):

| Artifact | Approx. size for 10 GB uploaded |
|---|---|
| Originals (Premium) | 10 GB |
| Display variants (1920 px) | ~4 GB |
| Thumbnails (400 px) | ~0.4 GB |
| ZIP parts — permanent | ~10 GB |
| **Total (current)** | **~24 GB** |

With TTL expiry and lazy rebuild, ZIP parts only exist during the active download window
(typically the first 1–2 weeks after an event). Outside that window they cost nothing.

# Proposed TTL Behaviour

1. **S3 lifecycle rule** targets the prefix `{eventId}/archive/` with an expiry of N days
   (default 14, configurable per tier). AWS/MinIO deletes expired objects automatically.
2. **DB state diverges from S3**: after expiry the `DownloadArchivePart` rows still exist but
   their S3 objects are gone. A new `expiredAt` timestamp or a periodic S3 head-check marks
   parts as `EXPIRED`.
3. **Download request hits an EXPIRED archive**: the API treats this exactly like a fresh
   event with no archive — it triggers a reconcile build and returns the "building" state to
   the guest UI. The existing SSE progress stream already handles this case.
4. **Rebuild**: the existing reconcile path runs normally. Because the immutability invariant
   is defined by `membershipSig` (photo set hash) rather than S3 object existence, the
   `DownloadArchivePart` rows can be kept or reset depending on chosen strategy (see below).

# Two Rebuild Strategies

## Option A — Reset membership on expiry (simpler)

Drop all `DownloadArchivePart` and `DownloadArchivePartEntry` rows when parts expire. A full
rebuild re-plans parts from scratch. Guests lose their "already downloaded" localStorage ticks.

**Pro**: no special DB migration. Behaves exactly like a fresh event.  
**Con**: guests who return after TTL must re-download everything. Annoying for large galleries.

## Option B — Keep membership rows, rebuild bytes only (preferred)

Keep the `DownloadArchivePartEntry` rows (photo membership). Mark parts `STALE` on expiry.
The reconcile path rebuilds each part from its stored membership — same `partIndex`,
same `membershipSig`, new `generation`. Guests' localStorage ticks survive because the tick
key is `(partIndex, membershipSig)`.

**Pro**: returning guests see the same part structure; already-downloaded parts stay green.  
**Con**: requires detecting expiry (periodic reaper or on-request head-check) and marking
parts `STALE` without a human-triggered rebuild action.

Option B aligns with the existing crash-recovery and deletion-reconcile paths and is the
intended direction.

# Storage Tier Implications

TTL expiry interacts directly with the Basic/Premium storage tier split (see
[KEDA Worker Scaling](/decisions/keda-worker-scaling.md)):

| Tier | Originals | ZIP TTL | Expected storage ratio |
|---|---|---|---|
| Basic | Deleted after resize | 14 days | ~0.5× uploaded (outside download window) |
| Basic | Deleted after resize | 14 days | ~1.0× uploaded (during download window) |
| Premium | Kept | 30 days | ~1.5× uploaded (outside download window) |
| Premium | Kept | 30 days | ~2.5× uploaded (during download window) |

Storage quota presented to the user is charged against uploaded bytes only. ZIP parts and
derived variants are infrastructure overhead absorbed into the margin.

# What Needs to Change

## S3 / MinIO
- [ ] Configure lifecycle rules per-bucket or per-prefix for `*/archive/*` objects.
- [ ] For MinIO (self-hosted bundled): MinIO supports lifecycle rules via `mc ilm add`.
      Document this in the Helm chart values and the operator guide.
- [ ] Verify that the existing orphan sweep in the archive builder (`deleteOrphanedArchives`)
      does not race with lifecycle expiry (should be safe — sweep only deletes objects it
      knows about via DB rows).

## Database
- [ ] Add `expiredAt` (nullable timestamp) to `DownloadArchivePart`.
- [ ] Add an expiry reaper: periodically (e.g. every hour) check S3 head for READY parts
      that are older than TTL − buffer. Mark stale without triggering an immediate build
      (let the next download request trigger the rebuild lazily).
- [ ] Alternatively: on-request head-check — when the download API is called, verify the
      S3 object exists before returning a presigned URL. On 404, mark STALE and queue a
      reconcile. Simpler, but adds latency to the first download request after expiry.

## API / UX
- [ ] The guest download page already handles the `building` state gracefully. No UI change
      required for the rebuild flow.
- [ ] Consider a banner: "Your archive expired and is being rebuilt. This takes a few minutes."
      to set expectations for returning guests.

## Admin
- [ ] Expose TTL configuration as a per-event or per-tier setting in the admin UI (future).
- [ ] The existing `POST /api/events/:id/download/rebuild-all` already serves as a manual
      "force rebuild after expiry" escape hatch.

# Non-Goals

- Streaming ZIPs on-demand without S3 storage: considered but rejected for large galleries
  (10 GB+ streams tie up a long-lived HTTP connection, are not resumable, and break the
  multi-part UX). Pre-built parts with lazy rebuild is the right trade-off.
- Per-guest TTL: TTL operates at the event level, not per guest. All guests share the same
  archive parts.

# Citations

[1] [Archive generation architecture](/architecture/archive-generation.md)
[2] [Multi-part archive decision](/decisions/multi-part-archive.md)
[3] [KEDA worker scaling concept](/concepts/keda-worker-scaling.md)
[4] [Download Jobs data model](/data-model/download-jobs.md)
