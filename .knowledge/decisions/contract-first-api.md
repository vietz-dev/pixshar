---
type: Decision
title: Contract-first API (oRPC)
description: Why every JSON endpoint is an oRPC procedure declared in a shared contract package, while the SSE streams stay plain Hono routes.
tags: [api, orpc, contracts, hono, effect]
timestamp: 2026-09-24T00:00:00Z
---

# Decision

All JSON endpoints are **oRPC v1 procedures**, declared once in `packages/contracts` (`@pixshar/contracts`) with `oc.input(...).errors(...).output(...)`, implemented on the server with `implement<Contract, RpcContext>(contract)`, and called from the browser through a typed `RPCLink` client. The handler is mounted on Hono at `/api/rpc/*`. The six non-JSON endpoints (four SSE streams plus the backfill POST stream) stay plain Hono routes; only their payload *types* live in the contract.

# Why

Adding an endpoint used to be a five-place edit: Hono handler, a per-handler Zod schema, a locally re-declared `interface` in the consuming page, the `fetch` call, and sometimes an unused type in `packages/shared`. Response shapes were asserted by casting `res.json()`, so a server-side rename surfaced as `undefined` at runtime, not as a type error. Errors were English strings the client matched on.

With the contract, the request and response schema, the error codes and the client type are one declaration. `packages/contracts` is path-mapped to `src/` by **both** apps, so the API and the web build always see the same file state — the flaw that ruled out extending `packages/shared`, which the web app type-checked against `dist/`.

# What it replaced

- `packages/shared` — 15 hand-written types with one importer — is deleted; contract-inferred types replace it.
- `routes/{events,gallery,upload}.ts` are gone. What remains under `routes/` is the BetterAuth catch-all, `streams.ts`, `backfill.ts`, `metrics.ts` and the health checks.
- The auth/ownership/rate-limit triad copied into every handler is now three middlewares (`adminOs`, `requireOwner`/`requireOwnedEvent`, `rateLimit`) declared at the procedure.
- `{ error: string }` + hand-picked statuses became oRPC error codes (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `TOO_MANY_REQUESTS`), which map to the same HTTP statuses the API returned before. The web app branches on the code.

# Consequences and constraints

- **Mount order**: the RPC middleware runs before the remaining `/api` routers, and Hono's `bodyLimit` must not consume the request body before `handler.handle` reads it.
- **Cookies from inside a procedure**: `gallery.unlock` needs `ResponseHeadersPlugin` from `@orpc/server/plugins` — `context.resHeaders` is how the gallery session cookie is set.
- **Same-origin**: mounting under `/api/rpc` (not `/rpc`) means the existing Next.js catch-all proxy carries RPC traffic unchanged, cookies included.
- **Streams stay REST**: an `EventSource` cannot speak RPC, and the alternative (async-iterator procedures) would give up the browser's native reconnect, the 120 s `Bun.serve` idle timeout and the metrics middleware's `/stream` skip.
- **Testability**: `createApp(resolveContext)` takes the context resolver as a parameter, so the three access levels can be driven in-process with no socket, no Postgres and no BetterAuth.
- **Effect stays scoped**: only the download/archive domain runs on the request path through a `ManagedRuntime` (`runService` + `DownloadService`). Plain CRUD stays plain async — see [Backend](/architecture/backend.md).

# Citations

[1] [Backend architecture](/architecture/backend.md)
[2] [Admin API](/api/admin-api.md)
[3] [Gallery API](/api/gallery-api.md)
[4] [oRPC documentation](https://orpc.unnoq.com)
