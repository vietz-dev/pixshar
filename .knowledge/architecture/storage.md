---
type: Architecture
title: Storage
description: S3-compatible object storage with presigned URLs; Minio bundled for self-hosting.
tags: [storage, s3, minio, presigned-urls]
timestamp: 2026-07-12T00:00:00Z
---

# Object Storage

Pixshar uses any **S3-compatible** object storage. In self-hosted deployments, **Minio** is bundled in Docker Compose and Helm. For cloud deployments, any S3-compatible service (AWS S3, Backblaze B2, Cloudflare R2, etc.) can be configured via environment variables.

# Bucket Layout

All files live in **one bucket**, organized by event ID and variant:

```
{eventId}/originals/{photoId}.{ext}   — as-uploaded original
{eventId}/display/{photoId}.jpg       — 1920 px resized for lightbox display
{eventId}/thumbs/{photoId}.jpg        — 400 px thumbnail for grid
{eventId}/archive/{quality}-part-{n}-g{gen}.zip — downloadable archive part(s), per variant
```

Archive objects carry the variant (`DISPLAY` = Kompakt, `ORIGINAL`) as a key segment so an event's two archives share the `archive/` prefix without colliding. Kompakt parts zip the `display/` objects; Original parts zip the `originals/`. Legacy `gallery-part-…` keys predate the variant split and count as `ORIGINAL`.

Using a single bucket with path prefixes rather than per-event buckets simplifies IAM, reduces API overhead, and makes cleanup (delete everything under `{eventId}/`) a single prefix operation.

# Presigned URLs

Photos and archive downloads are **never proxied through the API server**. Instead, the API generates time-limited presigned URLs (signed with AWS Signature V4) and returns them to the browser. The browser then fetches the content directly from S3/Minio.

Benefits: no bandwidth cost on the API, no memory pressure from streaming large files through the server, and uploads also go directly from browser to S3 (presigned PUT).

# Two S3 Client Instances

Two S3 client instances are maintained:

| Client | Endpoint | Used for |
|---|---|---|
| `s3` | Internal endpoint (within Docker/k8s network) | Server-side object operations (GetObject, HeadObject, DeleteObject) |
| `s3Public` | Public/browser-reachable endpoint | Generating presigned URLs the browser will use |

This separation is necessary because the browser cannot reach the internal Docker network hostname, but presigned URLs must be resolvable by the browser.

# Presigned URL Expiry

| Use case | Expiry |
|---|---|
| Thumbnail / display URLs returned in gallery API | 15 minutes (re-fetched on next gallery load) |
| Archive part download URLs | 15 minutes (down from 1 hour) |
| Admin per-photo download | 5 minutes |

Archive part URLs are no longer handed to the guest directly in the download payload — the
payload's part `url` now points at the API's `GET /api/gallery/:slug/download/part/:index`
redirect endpoint, which mints a fresh 15-minute presigned URL per click and 302s to it. This is
the real-download signal that drives archive idle expiry; see
[Archiv-Lebenszeit](/decisions/archive-lifetime.md). Bytes still stream directly from S3 — only
the URL-minting step gained one redirect hop.

# Citations

[1] [Minio documentation](https://min.io/docs)
[2] [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
[3] [Why presigned URLs over proxy](/decisions/presigned-urls.md)
[4] [Archiv-Lebenszeit decision](/decisions/archive-lifetime.md)
