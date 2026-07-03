---
type: Decision
title: Presigned URLs over API proxy
description: Photos and archives are served directly from S3 using presigned URLs, never proxied through the API server.
tags: [decision, storage, performance, s3]
timestamp: 2026-07-03T00:00:00Z
---

# Decision

Photos (thumbnails, display images) and archive downloads are served directly from S3 using time-limited, signed URLs. The API server never streams photo bytes to clients.

# Rationale

**Bandwidth and memory:** A gallery with 500 photos at 5 MB each is 2.5 GB. If the API proxied every request, a single busy gallery event would saturate the server's network interface and heap. S3 (or Minio) is purpose-built for high-throughput object delivery; the API is not.

**Horizontal scaling:** Presigned URLs make each HTTP response from the API stateless and tiny (a JSON payload with URLs). API replicas can be scaled independently of storage throughput.

**Upload symmetry:** The same mechanism is used for uploads (presigned `PUT`). This means the API never touches image bytes in either direction — consistent architecture with a single "I/O belongs in S3" principle.

**Self-hosting simplicity:** Minio, which is bundled for self-hosting, handles presigned URLs identically to AWS S3. No additional proxy tier is needed.

# Trade-offs Accepted

- **URL expiry UX:** Presigned URLs expire (15 min for photos, 1 h for archive parts). Guests who leave the gallery tab open overnight and try to open a lightbox may see an expired URL. The frontend handles this by re-fetching gallery data when a presigned URL fails. This was judged acceptable given the target use case (short-session photo browsing at events).
- **Two S3 client instances:** Because presigned URLs must be resolvable by the browser, the public endpoint (not the internal Docker network hostname) must be embedded in the URL. The API maintains two S3 client configurations — one for internal ops, one for generating public-facing URLs.

# Alternatives Considered

**API proxy:** Every photo request would go through the API (`GET /api/photos/:id`). Rejected: bandwidth cost, memory pressure, no advantage over direct S3.

**CDN in front of S3:** Would allow caching and longer-lived URLs. Not adopted for the initial version because Pixshar's target audience (self-hosters, small events) does not need CDN-level throughput, and adding a CDN layer increases deployment complexity.

# Citations

[1] [Storage architecture](/architecture/storage.md)
[2] [Upload API](/api/upload-api.md)
