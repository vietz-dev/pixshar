---
type: Decision
title: Graceful Shutdown & Zero-Downtime Deployments
description: Why uploads and downloads survive API restarts by design, and how Kubernetes rolling updates can be made zero-downtime via an opt-in HA flag.
tags: [decision, deployment, kubernetes, helm, availability]
timestamp: 2026-07-04T00:00:00Z
---

# Decision

Pixshar uses an opt-in `api.highAvailability` flag in the Helm chart for zero-downtime rolling updates. This is disabled by default to keep single-node self-hosting simple.

The API server handles SIGTERM gracefully: it stops accepting new connections (`server.stop(true)`), waits for in-flight HTTP requests to complete, and then drains the pg-boss job queue before exiting.

# Why Uploads and Downloads Are Already Safe

File uploads and downloads never flow through the API. Browsers upload directly to S3 using presigned PUT URLs (15-minute TTL); photos are served directly from S3 using presigned GET URLs (1-hour TTL). See [presigned-urls.md](/decisions/presigned-urls.md).

This means the API is only involved in short, stateless requests:
- Issuing presigned URLs (~50ms)
- Receiving upload completion confirmation (~50ms)
- Serving the gallery metadata page (~100ms)
- Keeping SSE event streams open (long-lived, but reconnectable)

Image processing jobs are durable in pg-boss (PostgreSQL). The worker already implements `boss.stop({ graceful: true })` on SIGTERM — in-flight jobs complete before the process exits, and any interrupted jobs are retried on restart.

# What `api.highAvailability.enabled: true` Adds

| Mechanism | Effect |
|-----------|--------|
| `maxUnavailable: 0, maxSurge: 1` | New pod must be Ready before old pod is terminated |
| `preStop sleep (5s)` | Buffer for kube-proxy and ingress to drain the pod from rotation before SIGTERM — prevents 502s |
| `terminationGracePeriodSeconds: 60` | Grace period for SSE streams and in-flight requests |
| `PodDisruptionBudget` | Ensures minimum availability during voluntary disruptions (node drains) |

# Why Opt-In (Default: false)

- PDB requires ≥2 schedulable nodes to be effective; single-node home-server setups gain nothing
- `maxUnavailable: 0` requires temporarily running 2 API pods during rollouts — needs node headroom
- Self-hosting target audience values simplicity over operational complexity
- The actual blast radius of a deployment without HA is already tiny (only the brief API request windows)

# Docker Compose

No graceful shutdown mechanism is implemented for Docker Compose. `docker compose up --build` causes a 1–3 second interruption. Recommended practice: deploy outside active photo event sessions.
