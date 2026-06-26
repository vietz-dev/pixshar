# Pixshar — Backlog

Follow-ups from the Postgres migration + durable-pipeline + SSE work. Ordered roughly by priority within each section.

## Ship / immediate

- [ ] **Rebuild & deploy the pending fixes.** API + web both changed (streaming proxy, Bun `idleTimeout`, SSE keepalive, `onerror` auto-reconnect, grid backfill, auth fixes). Run `docker compose up --build -d`. The current `:3000` container predates these.
- [ ] **Delete the "Browser Test" event** (70 sample photos) left over from manual testing — admin UI → Delete, or it can stay as scratch data.

## Multi-replica correctness (the stated deployment goal)

- [ ] **Cross-process SSE event bus.** `apps/api/src/lib/eventBus.ts` is an in-memory `EventEmitter` — per process. With >1 API replica, a photo/zip update emitted on replica A never reaches SSE clients connected to replica B. Today the admin grid backfill (refetch on processed-count rise) papers over it, but it's not instant and the gallery view has no backfill. Replace the bus with **Postgres `LISTEN/NOTIFY`** (no new infra) or Redis pub/sub so emits fan out to all replicas.
- [ ] **Gallery live-update backfill.** `apps/web/src/app/gallery/[slug]/view/page.tsx` updates the grid only from `photo-new` events — no count-based refetch like the admin page has. On an SSE reconnect it can miss photos. Add an equivalent backfill (e.g. a lightweight periodic refetch while the page is open, or a count signal).
- [ ] **Verify multi-replica end to end.** Deploy Helm with `api.replicaCount: 2` against one Postgres and re-run: bulk upload (no double-processing — `SKIP LOCKED`), zip build (exactly one builder via `claimJob`), and crash recovery (reapers). Plan step "I".

## Data / migration

- [ ] **Migration history was reset** for the SQLite→Postgres switch (single `init` migration). Any environment with real data needs a **dump + restore / data migration**, not `prisma migrate deploy`. Document the upgrade path before anyone runs this on existing data.
- [ ] **Validate Helm DB modes on a real cluster.** `helm template` renders all three (bundled / CNPG `uri` secret / assembled parts), but actually deploy with **CNPG + openBAO-synced secret** to confirm the `externalDatabase.existingSecret`+`uri` path works against a live CNPG cluster.

## Robustness / edges (from the pipeline review)

- [ ] **Scale-test bulk upload.** Only ~70 small images were exercised by hand. The real scenario is multiple guests bulk-uploading **hundreds–thousands** of large originals concurrently (sample set is 2000 / 531 MB). Verify queue throughput, memory under 8 concurrent resizes, and zip build time for large galleries.
- [ ] **Presigned download-URL expiry.** Archive + photo download URLs are 1 h. A link shared/bookmarked by a guest 403s after expiry with no refresh path. Consider a redirect endpoint that mints a fresh URL on demand.
- [ ] **Investigate stray gallery SSE on the admin page.** During testing the admin event page opened `GET /api/gallery/<slug>/download/stream` (→ 401, no gallery cookie). The admin page shouldn't open a gallery stream — likely a stray `EventSource`/prefetch. Track down and remove.
- [ ] **`onerror` hard-failure backoff.** SSE components now rely on native EventSource auto-reconnect. Confirm a persistent failure (e.g. expired admin session → 401) doesn't reconnect-loop; add a bounded backoff / redirect-to-login if it does.

## Testing / hardening

- [ ] **Automated tests for the new pipeline.** No coverage for: durable claim (`resizeWorker` `claimBatch` / reaper), zip state machine (debounce maxWait, heartbeat reaper, guarded transitions), SSE handlers, and the streaming proxy. Add integration tests (Postgres + MinIO via testcontainers or the compose stack).
- [ ] **Tune queue/zip constants for production.** `PROCESS_BATCH=8`, `PROCESS_MIN_AGE_MS=3000`, `DOWNLOAD_DEBOUNCE_SECONDS=60`, `DOWNLOAD_MAX_WAIT_SECONDS=120`, `*_LEASE_SECONDS` — defaults are guesses; revisit against real upload patterns and instance sizing.

## Verified working (reference — no action)

- Streaming `/api/*` proxy (Route Handler) — SSE no longer buffered/dropped; client-abort handled.
- Bun `idleTimeout: 120` + 15 s keepalive — streams stay open (were dying at ~12 s).
- Durable resize queue on Postgres (`SKIP LOCKED` claim, retry/backoff, stale reaper).
- Zip job hardening (debounce max-wait ceiling, heartbeat lease + periodic reaper, stale-zip delete, guarded BUILDING writes).
- Live admin overview: grid + processing + archive panel update without reload; guest "Download all" enables on READY.
- Auth fixes: `/api/auth/*` wildcard route, Prisma adapter `provider: "postgresql"`.
