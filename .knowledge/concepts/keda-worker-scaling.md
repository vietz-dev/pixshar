---
type: Concept
title: KEDA-based worker autoscaling for hosted SaaS
description: Future concept for scaling photo-resize and ZIP-builder workers to zero on Kubernetes using KEDA queue-depth triggers.
tags: [concept, future, keda, kubernetes, scaling, saas, worker, zip]
status: future — not yet implemented
timestamp: 2026-07-12T00:00:00Z
---

# Concept

For a hosted (multi-tenant) Pixshar offering, worker pods should scale to zero when idle and
scale up rapidly when events are being processed or ZIPs are requested. **KEDA** (Kubernetes
Event-Driven Autoscaling) with a Postgres queue-depth scaler is the intended mechanism.

This concept is not yet implemented. It is recorded here so the architecture is not accidentally
broken before it is built.

# Problem

The current single-process worker model works well for self-hosted single-tenant deployments.
In a hosted SaaS context two new problems arise:

1. **Cross-event contention**: a large event (1 000+ photos) monopolises the worker and stalls
   smaller events queued behind it.
2. **Idle cost**: a permanently-running worker wastes resources between events, which follow
   a bursty pattern (heavy during/after the event, silent otherwise).

Per-event pods were considered but rejected: they require bespoke orchestration, suffer from
K8s cold-start latency (10–30 s), and create O(events) pods when many events are active
simultaneously.

# Proposed Architecture

```
                  ┌─────────────────────┐
                  │   Postgres (queue)   │
                  │  PENDING photo rows  │
                  │  ZIP_REQUESTED rows  │
                  └──────────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼                             ▼
    KEDA ScaledJob                 KEDA ScaledJob
    resize-worker (0→N pods)       zip-builder (0→N pods)
    FOR UPDATE SKIP LOCKED         serial FIFO per worker
              │                             │
              └──────────────┬──────────────┘
                             ▼
                            S3
```

Both worker types share the existing Postgres queue mechanism (`FOR UPDATE SKIP LOCKED`).
KEDA watches queue depth (number of PENDING/ZIP_REQUESTED rows) and scales replicas
accordingly:

| Queue depth | Resize worker pods | ZIP builder pods |
|---|---|---|
| 0 | 0 | 0 |
| 1–50 | 1 | 1 |
| 51–200 | 2–3 | 1 |
| 200+ | up to max | 1–2 |

# ZIP-Build Flow with Lazy TTL

Pre-built permanent ZIPs roughly double storage cost because JPEG files are already compressed
and ZIP adds negligible compression. The intended flow is:

1. Guest clicks "Download".
2. API checks S3 for a cached ZIP object.
3. **Hit** → return presigned URL immediately.
4. **Miss** → insert a `ZIP_REQUESTED` job row, return a job ID, UI polls for completion.
5. KEDA sees the new row and scales up a zip-builder pod within seconds.
6. Zip-builder streams objects from S3, builds archive, uploads back to S3.
7. S3 lifecycle rule auto-expires ZIP objects after N days (default 14).
8. On next request after expiry → repeat from step 4.

This ensures ZIPs only consume storage during the burst period when downloads are actually
happening.

# Storage Tier Implications

This architecture enables a clean Basic/Premium split:

| Tier | Originals kept | Download quality | Expected storage ratio |
|---|---|---|---|
| Basic | No (deleted after resize) | Display (1920 px) | ~0.5× uploaded |
| Premium | Yes | Original + display | ~1.5× uploaded (excl. transient ZIPs) |

Storage quota is charged against what the user uploaded, not the derived variants or
transient ZIPs. The infrastructure overhead is absorbed into the margin.

# Prerequisites Before Implementation

- [ ] ZIP builds promoted to a first-class queue job type with their own DB table/fields
      (currently implemented as hand-rolled `DownloadJob` state machine — verify compatibility)
- [ ] KEDA installed in the hosted K8s cluster
- [ ] Postgres scaler configured (`SELECT COUNT(*) FROM ... WHERE status = 'PENDING'`)
- [ ] ~~S3 lifecycle rules for ZIP TTL~~ — superseded: ZIP idle-expiry shipped as an app-side
      reaper, not S3 lifecycle rules (S3 expiry is age-based, not access-based; see
      [Archiv-Lebenszeit](/decisions/archive-lifetime.md))
- [ ] UI: "Building ZIP…" progress screen with SSE or polling (already partially present
      via the archive SSE stream — review for reuse)
- [ ] `DELETE originals after processing` flag per tier in Event/tenant config

# Citations

[1] [Durable queue decision](/decisions/durable-queue.md)
[2] [Archive generation architecture](/architecture/archive-generation.md)
[3] [Archiv-Lebenszeit decision](/decisions/archive-lifetime.md)
[4] [KEDA Postgres scaler docs](https://keda.sh/docs/latest/scalers/postgresql/)
