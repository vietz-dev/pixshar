---
type: Decision
title: Durable queue via pg-boss and DB polling
description: Photo resize uses pg-boss; archive builds use a bespoke DB-polling loop. Both store state in Postgres.
tags: [decision, queue, pg-boss, durability, worker]
timestamp: 2026-07-03T00:00:00Z
---

# Decision

Two separate queuing mechanisms are used:

1. **Photo resize** → **pg-boss** (a full-featured PostgreSQL-backed job queue library).
2. **Archive builds** → a hand-rolled DB-polling loop with a `DownloadJob` table acting as both queue and state machine.

Both approaches share the same invariant: **Postgres is the source of truth**. If the worker process crashes and restarts, no work is lost.

# Why pg-boss for Photo Resize

Photo resize is a classical background job: enqueue-once, process-once, retry on failure. pg-boss provides this out of the box:

- `FOR UPDATE SKIP LOCKED` for safe concurrent dequeue across replicas
- Built-in exponential backoff retry
- Job deduplication support (useful for idempotency on retries)
- Cron-style scheduled jobs (used for the stale-PROCESSING reaper)

Postgres was already a hard dependency (Prisma). pg-boss adds no new infrastructure.

# Why Not pg-boss for Archive Builds

Archive builds are fundamentally different from photo resize jobs:

- **Long-running (minutes to hours):** pg-boss's visibility timeout model assumes jobs complete "soon." A 10 GB archive may run for 30+ minutes.
- **One-at-a-time per process:** The desired behavior is a serial FIFO queue per worker replica, not a round-robin across workers. pg-boss's worker model does not map cleanly to this.
- **Rich state machine:** The `DownloadJob` transitions through 6 states with fields like `debounceUntil`, `heartbeatAt`, `partCount` that need to be inspected by the API's SSE streams. A pg-boss job row carries far less metadata.
- **Supersede semantics:** When a force-rebuild is triggered, the currently-building job must be cancelled mid-stream. pg-boss provides no mechanism for this.

The hand-rolled approach keeps the state machine in a Prisma model, queryable by both the worker and the API, and gives full control over CAS transitions and crash recovery.

# Durability Guarantees

| Concern | Photo Resize | Archive Build |
|---|---|---|
| Crash recovery | pg-boss requeues stale-PROCESSING jobs | Reaper detects stale `heartbeatAt`, requeues to QUEUED |
| Duplicate prevention | pg-boss `SKIP LOCKED` | CAS `WHERE status = 'QUEUED'` claim |
| Max attempts | `PROCESS_MAX_ATTEMPTS` (default 4) | `DOWNLOAD_MAX_ATTEMPTS` (default 3) |
| Backoff | pg-boss exponential | Effect `Schedule.exponential` |

# Citations

[1] [Image processing architecture](/architecture/image-processing.md)
[2] [Archive generation architecture](/architecture/archive-generation.md)
[3] [pg-boss documentation](https://github.com/timgit/pg-boss)
