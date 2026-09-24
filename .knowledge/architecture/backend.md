---
type: Architecture
title: Backend
description: Hono HTTP server running on Bun serving a contract-first oRPC API, with Effect for error-safe async pipelines.
tags: [backend, hono, bun, effect, zod, orpc]
timestamp: 2026-09-24T00:00:00Z
---

# Runtime

The API process runs on **Bun** — a JavaScript runtime with built-in TypeScript support and fast startup. Bun replaces Node.js as the execution environment; npm packages that depend on Node.js internals are avoided where possible. The worker process (image processing + archive builds) also runs on Bun.

# HTTP Framework

**Hono** is the HTTP framework. It is lightweight, edge-compatible, and has first-class TypeScript support. Middleware is composed per-route using Hono's `app.use()` and route-level guards. Key middleware used:

- `hono/cors` — CORS restricted to the configured `WEB_URL`
- `hono/body-limit` — 100 MB cap to prevent memory exhaustion from large uploads
- `hono/streaming` — SSE streams for real-time status updates
- `requireAdmin` / `requireGallerySession` — session guards for the surviving SSE routes

Hono carries the transport; it no longer carries the API surface. One middleware at `/api/rpc/*` resolves the per-request context and hands the request to the oRPC handler, and what is left of `routes/` is the BetterAuth catch-all, `streams.ts`, `backfill.ts`, `metrics.ts` and the health checks. `createApp(resolveContext)` takes the context resolver as a parameter so the API can be driven in-process by tests.

# API Surface

Every JSON endpoint is an **oRPC procedure** declared in `packages/contracts` and implemented in `src/rpc/`. Access rules are middleware declared at the procedure (`adminOs`, `galleryOs`, `requireOwner`, `rateLimit`), not code copied into handler bodies, and failures are error codes rather than English strings. The four SSE streams stay plain Hono routes. See [Contract-first API](/decisions/contract-first-api.md).

# Effect

**Effect** (the TypeScript functional effects library) is used for any async pipeline that can fail and should retry. It provides:

- Deterministic error handling without try/catch
- Typed errors that flow through the entire pipeline
- Structured concurrency (`Effect.all` for parallel ops)
- Built-in retry with exponential backoff (`Effect.retry`)

Effect is used in:
- The image processing pipeline (resize + upload + DB update)
- The archive build pipeline (part planning + streaming + S3 upload)
- The download/archive procedures on the request path, through a single `ManagedRuntime` created by `@vietz-dev/hono-effect`: handlers are `runService(DownloadService, …)` one-liners and never call `Effect.runPromise` themselves. The runtime's scoped resources are released by `dispose()` during the SIGTERM drain.

Effect is **not** used for simple CRUD handlers — those are plain async functions. The principle is: use Effect where the operation has meaningful retry semantics or multiple typed failure modes.

# Validation

All external input is validated with **Zod** at system boundaries. For RPC calls that validation *is* the contract: the procedure's input schema runs before the handler, and a violation comes back as `BAD_REQUEST` rather than a raw `ZodError`. Env vars and the surviving Hono routes keep their own Zod checks. Internal functions trust their inputs. Failures on the RPC surface carry an oRPC error code mapped to the HTTP status the endpoint returned before; the remaining Hono routes still answer `{ error: string }`.

# Two Processes

The application intentionally splits into two processes in production:

| Process | Purpose |
|---|---|
| `api` | Serves HTTP requests, manages admin/gallery sessions |
| `image-processor` | Runs pg-boss worker (photo resize) + archive build poller |

This split means heavy CPU/IO work (resizing, zipping) never blocks request handling. The API process remains responsive under load.

# Inter-Process Communication

The worker process notifies the API process of state changes via **PostgreSQL `pg_notify`**. The API maintains a LISTEN connection and emits events on its in-process event bus, which SSE stream handlers subscribe to. This avoids polling from the API and keeps SSE latency low.

# Citations

[1] [Hono documentation](https://hono.dev)
[2] [Effect documentation](https://effect.website)
[3] [Bun documentation](https://bun.sh)
