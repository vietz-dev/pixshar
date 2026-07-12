# Architectural Decisions

* [Presigned URLs](presigned-urls.md) - Why photos are served directly from S3, never proxied through the API
* [Gallery Sessions](gallery-sessions.md) - Why guests use per-event JWT cookies instead of user accounts
* [Single S3 Bucket](single-s3-bucket.md) - Why one bucket with path prefixes instead of per-event buckets
* [Durable Queue](durable-queue.md) - Why pg-boss for photo resize and DB-polling for archive builds
* [Multi-Part Archive](multi-part-archive.md) - Why large galleries are split into ≤2 GB parts and streamed
* [Gallery Password Encryption](gallery-password-encryption.md) - Why gallery passwords are stored AES-256-GCM encrypted (not plaintext) and the key-management model
* [Graceful Shutdown & HA](graceful-shutdown.md) - Why uploads survive API restarts by design, and how the opt-in Helm HA flag enables zero-downtime Kubernetes rolling updates
* [Download-Varianten](download-variants.md) - Why an event can offer both a Kompakt (display-image) and an Original archive as two independent per-quality DownloadJobs, with a Kompakt-default guest toggle (build timing itself is now lazy — see Archiv-Lebenszeit)
* [Archiv-Lebenszeit](archive-lifetime.md) - Why an archive is a cache, not an artifact — lazy build on explicit request only, idle expiry via an app-side CAS-claiming reaper (not S3 lifecycle rules), rebuild from preserved membership, and the row-before-object ordering rule that keeps a guest from ever being 302'd to a deleted key
