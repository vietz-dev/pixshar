---
type: Architecture
title: Archive Generation
description: Streaming multi-part ZIP build with per-process FIFO serialization and a DB-backed state machine. Archives are built only on explicit request and idle-expired by an app-side reaper.
tags: [archive, zip, download, streaming, queue, quality, expiry]
timestamp: 2026-07-12T00:00:00Z
---

# Purpose

When guests download a gallery they receive a ZIP archive containing all PROCESSED photos. Because galleries can be large (10 GB+), the archive is:
1. **Streamed** — never fully buffered in memory; built incrementally and uploaded to S3 in multipart chunks.
2. **Split into parts** — each part is at most `DOWNLOAD_MAX_PART_BYTES` (default 2 GB), so an interrupted download loses only one part.
3. **Incremental & immutable** — parts are built once and sealed. A build appends only the newly-uploaded photos as **new** parts; existing parts are never re-planned. This makes "part N always contains the same photos" true by construction, so a returning guest only downloads the new parts.
4. **Available in two variants** — an event can offer both a **Kompakt** (compressed, from the display images) and an **Original** (full-resolution) archive; see [Download-Varianten](/decisions/download-variants.md).
5. **Built lazily, expired on idle** — nothing is built until a guest or admin explicitly asks for it, and a variant's S3 bytes are reclaimed after `DOWNLOAD_ARCHIVE_TTL_DAYS` of no real download, while its membership (which photo is in which part) survives so a later request rebuilds byte-identical parts. See [Archiv-Lebenszeit](/decisions/archive-lifetime.md) for the full rationale.

# Two variants per event

Each event has up to **two** `DownloadJob`s, one per `ArchiveQuality` (`DISPLAY` = Kompakt, `ORIGINAL`). The variant lives on the job because the job is the unit a worker atomically claims, so the two variants are independently claimable builds that can run on different replicas, minutes apart or never together. Both zip the same photo set — only the S3 source object differs (display image vs. original). Everything below (planning, streaming, immutability, crash recovery) applies per variant; the variant name is a segment in the S3 key so the two never collide.

# The immutability invariant

A photo, once assigned to part N, stays in part N until it is deleted. Every build path (append reconcile, deletion reconcile, admin rebuild-all) obeys this:
- No build adds a photo to an existing part or moves a photo between parts.
- Existing parts are rebuilt only from their **stored membership** (the `DownloadArchivePartEntry` rows), never from a fresh global plan.
- The only allowed change to an existing part is dropping deleted photos (it shrinks, never grows or reorders).
- The greedy planner (`planArchiveParts`) runs only over photos not yet assigned to any part, forming new parts.

# Trigger: lazy build, eager append

Nothing builds an archive except an explicit request. `requestBuild` (in
`services/downloadJob/triggers.ts`) is the single entry point that creates a `DownloadJob` — the
guest "Archiv erstellen" button (`POST /api/gallery/:slug/download/request?quality=`) and the
admin "Jetzt bauen" / pre-warm button both call it. Opening the download page (`GET /download`) is
a pure read: it builds nothing and creates no job. A variant that nobody has ever requested, or
whose bytes the idle reaper reclaimed (`EXPIRED`), stays that way until asked for again — an
upload never resurrects it.

Once a variant is *alive* (`READY`, `DEBOUNCING`, `QUEUED`, or `BUILDING`), it stays current: after
every successful photo processing step, `triggerDebounceAllVariants` appends the new photo to every
alive variant's debounce timer. Once uploads have been quiet for `DOWNLOAD_DEBOUNCE_SECONDS`
(default 60 s), the reconcile build is queued. A hard ceiling (`DOWNLOAD_MAX_WAIT_SECONDS`, default
120 s) prevents continuous uploads from starving the build. Re-entering DEBOUNCING never wipes
existing parts — they stay downloadable while the new photos are appended. This is the "lazy to
create, eager to keep current" rule at the heart of
[Archiv-Lebenszeit](/decisions/archive-lifetime.md): an archive nobody ever asked for costs
nothing; one that guests are actively downloading stays complete.

Photo deletion does **not** queue a build. It reclaims the S3 objects of the affected parts of
**both** variants immediately (see Deletion, below) — under the lazy model, waiting for the next
build to replace a stale object would leave a deleted photo downloadable indefinitely. The admin
rebuild-all/build-now actions still route through the same `triggerReconcile`/`requestBuild` queue.

# State Machine: DownloadJob

```
DEBOUNCING → QUEUED → BUILDING → READY → EXPIRED
                          ↑                   │
                          └──── request ──────┘
                              ↘ FAILED
                              ↘ CANCELLED
```

All transitions use atomic `updateMany` with a `WHERE status = <expected>` guard, so concurrent worker replicas can never double-build the same event's archive. `READY → EXPIRED` is caused by the idle reaper, the admin "release" action, or (parts only) a photo deletion; `EXPIRED → QUEUED` happens only through an explicit request — see [Archiv-Lebenszeit](/decisions/archive-lifetime.md) for the full state machine and the reaper's row-before-object ordering rule.

# Reconcile: Part Planning

Each build reconciles rather than rebuilds. It:
1. Loads existing parts + their membership; separates immutable `READY` parts (skipped) from parts that need a physical rebuild — `STALE` (a deletion touched them) or `EXPIRED` (the idle reaper reclaimed their bytes) are treated identically here.
2. Rebuilds each `STALE`/`EXPIRED` part from its stored membership minus any deleted photos (same `partIndex`, `generation + 1`). An emptied part is deleted; `partIndex` values are **not** renumbered (gaps are allowed to keep identities stable).
3. Appends photos not yet assigned to any part via a **greedy fill** (`planArchiveParts`, ordered by `createdAt`) into new parts with `partIndex` continuing past the current max. A single photo larger than the limit gets its own oversized part.

An `EXPIRED` job's `readyAt` is stamped fresh on every → `READY` transition, since it is one of the two inputs (with `lastDownloadedAt`) to the idle-expiry clock — see [Archiv-Lebenszeit](/decisions/archive-lifetime.md).

# Part identity: membershipSig & generation

- `membershipSig` = sha1 of the part's sorted photoId list. It is the content identity used by the guest's localStorage download-tracking, so a green "downloaded" tick persists across a pure byte-rebuild and resets only when the part's photo set actually changes (a deletion).
- `generation` is bumped on every physical (re)build and feeds the versioned S3 key (`{eventId}/archive/{quality}-part-{index}-g{gen}.zip`), so the old object stays downloadable until the new one is committed; the old object is deleted afterward. A per-build orphan sweep removes any archive object no longer referenced by a live part — scoped to the building variant's objects (legacy `gallery-part-…` keys count as `ORIGINAL`), so a Kompakt build never deletes an Original part.

# Streaming Pipeline

For each planned part:
1. An `archiver` instance (ZIP, store mode — no compression, since photos are already compressed JPEGs) pipes into a Node.js `PassThrough` stream.
2. The `PassThrough` feeds into an `@aws-sdk/lib-storage` multipart `Upload` (16 MB parts, 2-chunk queue — bounds peak memory to ~32 MB regardless of gallery size).
3. Photos are fetched from S3 one at a time via `GetObjectCommand` and appended to the archiver with backpressure. The S3 body stream is a Node.js `Readable`; archiver reads it and the PassThrough drains it.
4. After the last photo, `archive.finalize()` closes the ZIP and the multipart upload completes.
5. A `HeadObjectCommand` retrieves the final part size, and a `DownloadArchivePart` row is inserted.

Peak memory per build: ~32 MB of upload buffer + one S3 photo stream in flight at a time.

# Per-Process Serialization (FIFO)

Within a single image-processor process, at most **one archive build runs at a time**. This is enforced by a promise-chain mutex: each call to `runBuildZip` appends to a `buildChain` promise and is deduped by `(eventId, quality)`. Multiple pending builds queue FIFO (oldest `queuedAt` first).

Multiple worker replicas can build different jobs concurrently — each replica runs its own FIFO chain, and the per-job `QUEUED → BUILDING` CAS claim ensures no `(event, variant)` is built by two replicas simultaneously. Because the claim key is the job, the Kompakt and Original variants of one event are independently claimable and can build on different replicas.

# Crash Recovery

A heartbeat (`heartbeatAt`) is updated every few photos. A reaper (runs every `DOWNLOAD_BUILD_LEASE_SECONDS / 2`) detects BUILDING rows whose heartbeat is stale and resets them to QUEUED. Recovery is now cheap and safe: immutable `READY` parts are kept; only the in-flight new/rebuilt part is redone. A crashed rebuild leaves its part `STALE` (its old object still serving), so the next reconcile simply retries it.

# Admin controls

All four take a `?quality=` selector (default `ORIGINAL`) and act on exactly **one** variant, so the admin can, e.g., re-zip the cheap Kompakt archive without triggering the expensive Original rebuild across many parts. The admin UI renders two independent per-variant panels, each also showing whether the variant is `READY` or `EXPIRED` and (when `READY`) a remaining-lifetime countdown to its idle expiry.

- `POST /api/events/:id/download/build-now` — skip the debounce wait and queue the pending reconcile immediately. Also works from `NONE` or `EXPIRED` (pre-warm/rebuild): it creates the job if needed rather than only accelerating an existing one. Only the timer is skipped; it still routes through QUEUED → the FIFO claim, so worker/image-processor load stays bounded.
- `POST /api/events/:id/download/rebuild-all` — mark every part `STALE` and reconcile, regenerating each part's bytes from its stored membership. Membership is preserved, so guests are not forced to re-download parts whose contents did not change.
- `POST /api/events/:id/download/cancel` — stops the current build; already-committed (immutable) parts stay downloadable.
- `POST /api/events/:id/download/release` — reclaim this variant's S3 objects immediately instead of waiting for the idle reaper. Runs the exact same `expireArchive` effect the periodic reaper runs, so there is only one reclamation code path. No-op (`released: false`) when the variant isn't `READY`.

# Deletion

Deleting a photo (`DELETE /events/:id/photos[...]`) reclaims the S3 objects of exactly the parts containing it (looked up via the indexed `DownloadArchivePartEntry.photoId`) — across **both** variants' jobs — **immediately**, flipping those parts to `EXPIRED` and pruning the deleted photo from their membership. A part whose last member was deleted is removed entirely (row + entries); surviving parts keep their `partIndex`. No build is queued: under the lazy model there is no debounced reconcile to fall back on, so a build only happens when the next explicit request rebuilds the pruned membership (new `membershipSig`, since the content genuinely changed). Parts untouched by the deletion stay downloadable, so a guest who already grabbed an unaffected part isn't forced to re-download it. This is the one path that produces a partially-available `READY` variant; see [Archiv-Lebenszeit](/decisions/archive-lifetime.md) for why immediate reclamation (rather than the old STALE-and-reconcile-later window) is a correctness requirement once builds are lazy.

# Download UX

The guest download payload returns **both variants** in one response (`defaultQuality` = Kompakt, plus a `variants` map); each variant lists whatever parts are already built regardless of job state (partial availability), with a `building` flag when more parts are pending and a per-part `rebuilding` flag when a part is being updated (its old version stays downloadable meanwhile). Fetching this payload is a pure read — it neither creates a job nor starts a build.
- A variant with no job at all, or one whose bytes were idle-expired, shows an **"Archiv erstellen"** action instead of a part list; clicking it calls `POST .../download/request` and switches to a live building view. A returning guest whose archive expired sees a banner explaining it is being rebuilt.
- The download page shows a **segmented Kompakt/Original toggle** and renders only the selected variant's part list (a many-part gallery never shows a doubled list). Kompakt is always the default tab, even while it is still building — it never auto-switches to Original.
- Each tab carries its own summary (part count + size), build indicator, and "more parts coming" banner. A part being rebuilt is greyed.
- Clicking a part marks it downloaded in `localStorage`, keyed on `quality` + `partIndex` + `membershipSig` — so the two variants' ticks never collide and a rebuilt (changed) part resets while appended parts stay green. A part link points at `GET /api/gallery/:slug/download/part/:index`, not directly at S3 — that request is what stamps the archive's idle clock. The page live-updates via the SSE stream, which emits per-variant status.

# Citations

[1] [Multi-part archive decision](/decisions/multi-part-archive.md)
[2] [Download Jobs data model](/data-model/download-jobs.md)
[3] [Durable queue decision](/decisions/durable-queue.md)
[4] [Archiv-Lebenszeit decision](/decisions/archive-lifetime.md)
