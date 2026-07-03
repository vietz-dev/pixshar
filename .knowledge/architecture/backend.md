---
type: Architecture
title: Backend
description: Hono HTTP server running on Bun, with Effect for error-safe async pipelines and Zod for input validation.
tags: [backend, hono, bun, effect, zod]
timestamp: 2026-07-03T00:00:00Z
---

# Runtime

The API process runs on **Bun** — a JavaScript runtime with built-in TypeScript support and fast startup. Bun replaces Node.js as the execution environment; npm packages that depend on Node.js internals are avoided where possible. The worker process (image processing + archive builds) also runs on Bun.

# HTTP Framework

**Hono** is the HTTP framework. It is lightweight, edge-compatible, and has first-class TypeScript support. Middleware is composed per-route using Hono's `app.use()` and route-level guards. Key middleware used:

- `hono/cors` — CORS restricted to the configured `WEB_URL`
- `hono/body-limit` — 100 MB cap to prevent memory exhaustion from large uploads
- `hono/streaming` — SSE streams for real-time status updates
- `requireAdmin` — checks BetterAuth session
- `requireGallerySession` — validates per-event JWT cookie

# Effect

**Effect** (the TypeScript functional effects library) is used for any async pipeline that can fail and should retry. It provides:

- Deterministic error handling without try/catch
- Typed errors that flow through the entire pipeline
- Structured concurrency (`Effect.all` for parallel ops)
- Built-in retry with exponential backoff (`Effect.retry`)

Effect is used in:
- The image processing pipeline (resize + upload + DB update)
- The archive build pipeline (part planning + streaming + S3 upload)

Effect is **not** used for simple CRUD handlers — those are plain async functions. The principle is: use Effect where the operation has meaningful retry semantics or multiple typed failure modes.

# Validation

All external input (request bodies, query params, env vars) is validated with **Zod** at system boundaries. Internal functions trust their inputs. API responses on failure always have the shape `{ error: string }` with an appropriate HTTP status code.

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
