# Architecture

* [Frontend](frontend.md) - Next.js 15 App Router, styling, i18n, and client/server split
* [Backend](backend.md) - Hono + Bun HTTP server, Effect pipelines, Zod validation
* [Storage](storage.md) - S3-compatible object storage, presigned URLs, bucket layout
* [Auth](auth.md) - BetterAuth for admin, per-gallery JWT cookies for guests
* [Image Processing](image-processing.md) - pg-boss durable queue, resize worker, photo lifecycle
* [Archive Generation](archive-generation.md) - Multi-part ZIP streaming, FIFO build serialization, state machine
