---
type: Decision
title: Single S3 bucket with path prefixes
description: All events share one S3 bucket, organized by event ID in the key path.
tags: [decision, storage, s3, bucket]
timestamp: 2026-07-03T00:00:00Z
---

# Decision

All events and all photo variants (originals, display, thumbs, archives) live in one S3 bucket. The bucket key is always prefixed with the event ID:

```
{eventId}/originals/...
{eventId}/display/...
{eventId}/thumbs/...
{eventId}/archive/...
```

# Rationale

**One set of credentials:** A single bucket means one IAM policy, one access key pair, one set of environment variables (`S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`). Creating a new event requires no IAM changes.

**Atomic event deletion:** `events.delete` deletes everything under the prefix `{eventId}/` with a `ListObjectsV2` + `DeleteObjects` loop (up to 1000 keys per call). One logical delete operation covers all variants.

**Self-hosting simplicity:** Minio's bucket creation happens once at startup via the `minio-init` container. No automation is needed to provision per-event buckets.

**No S3 bucket limits:** AWS accounts have a default limit of 100 S3 buckets. A busy installation with thousands of events would hit this limit if each event had its own bucket.

# Trade-offs Accepted

- **IAM granularity:** It is not possible to grant a user S3 access to exactly one event's photos using standard IAM `Resource` ARNs, because IAM cannot express object-key-prefix conditions on pre-signed URL generation in all configurations. For Pixshar's single-admin, single-installation model, this is irrelevant.
- **Bucket-level encryption/retention policies:** Cannot be set per-event. Accepted for the same reason.

# Alternatives Considered

**One bucket per event:** Provides stronger isolation and simpler per-event IAM. Rejected due to the AWS bucket count limit and the operational overhead of bucket creation/deletion on every event lifecycle.

# Citations

[1] [Storage architecture](/architecture/storage.md)
[2] [Presigned URLs decision](/decisions/presigned-urls.md)
