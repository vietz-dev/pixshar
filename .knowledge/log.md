# Pixshar Knowledge Bundle — Update Log

## 2026-07-03
* **Initialization**: Created foundational OKF bundle covering product overview, architecture, data model, API, and architectural decisions.
* **Creation**: Added [overview](/overview.md), [frontend](/architecture/frontend.md), [backend](/architecture/backend.md), [storage](/architecture/storage.md), [auth](/architecture/auth.md), [image processing](/architecture/image-processing.md), [archive generation](/architecture/archive-generation.md).
* **Creation**: Added data model concepts for [events](/data-model/events.md), [photos](/data-model/photos.md), [download jobs](/data-model/download-jobs.md).
* **Creation**: Added API concepts for [gallery](/api/gallery-api.md), [admin](/api/admin-api.md), [upload](/api/upload-api.md).
* **Creation**: Added decision records for [presigned URLs](/decisions/presigned-urls.md), [gallery sessions](/decisions/gallery-sessions.md), [single S3 bucket](/decisions/single-s3-bucket.md), [durable queue](/decisions/durable-queue.md), [multi-part archive](/decisions/multi-part-archive.md).

## 2026-07-05
* **Change**: Archive parts are now **incremental and immutable**. A build no longer rewrites the whole archive on every upload — it appends only newly-uploaded photos as new parts and rebuilds a part in place only when a photo inside it is deleted. Updated [archive generation](/architecture/archive-generation.md), [multi-part archive decision](/decisions/multi-part-archive.md), [download jobs](/data-model/download-jobs.md).
* **Change**: Part identity: each part carries a `membershipSig` (content identity for client download-tracking) and a `generation` (versioned S3 key for old/new coexistence during a rebuild). New `DownloadArchivePartEntry` join table records durable part membership.
* **Change**: Admin controls split — `POST /download/build-now` (skip debounce, keep FIFO) and `POST /download/rebuild-all` (membership-preserving full rebuild) replace `POST /download/build`.

## 2026-07-11
* **Promotion**: [Download-Varianten](/decisions/download-variants.md) shipped — moved from `concepts/` to a Decision. Every event now always builds **two** archive variants, Kompakt (`DISPLAY`, from the display images) and Original (`ORIGINAL`), as two independent per-`quality` `DownloadJob`s. Kompakt is the guest default (opt-in Original); the Kompakt job is created lazily for pre-existing events.
* **Change**: `DownloadJob` gains `quality` with `@@unique([eventId, quality])`; parts inherit the variant; S3 archive keys gain a `{quality}-part-…` segment (legacy `gallery-part-…` = ORIGINAL). Updated [download jobs](/data-model/download-jobs.md), [storage](/architecture/storage.md).
* **Change**: The build trigger fans out over both variants (upload enqueues both; deletion stales both), the FIFO claim key is now `(event, quality)`, and the orphan sweep is variant-scoped. Updated [archive generation](/architecture/archive-generation.md).
* **Change**: `GET /api/gallery/:slug/download` returns both variants in one payload (Kompakt default); admin status/build-now/rebuild-all/cancel take a `?quality=` selector; the admin panel renders two per-variant panels and the guest page a Kompakt/Original toggle. Updated [gallery API](/api/gallery-api.md), [admin API](/api/admin-api.md).

## 2026-07-12
* **Rewrite**: [Archiv-Lebenszeit](/concepts/zip-ttl-storage.md) (vormals „ZIP TTL Storage") auf den beschlossenen Stand gebracht und als `specced` markiert — Tickets PIXSHAR-1 … PIXSHAR-9 in Plane. Der Dateiname bleibt vorerst, um die vier verlinkenden Dokumente nicht zu brechen; beim Promoten zur Decision wird umbenannt.
* **Refutation**: Der bisherige Vorschlag **S3-Lifecycle-Regeln** ist widerlegt — S3-Expiry ist altersbasiert, nicht zugriffsbasiert, und würde aktiv genutzte Archive löschen. Stattdessen ein anwendungseigener Idle-Reaper (CAS-Claim, erst Objekte löschen, dann Status kippen).
* **Change**: Der **eager Erstbau entfällt**. Archive entstehen nur noch auf explizite Anforderung (Gast-Button bzw. Admin-Pre-Warm); Uploads halten lediglich eine bereits lebende Variante aktuell („lazy beim Erschaffen, eager beim Aktuellhalten"). Betrifft [archive generation](/architecture/archive-generation.md) und [Download-Varianten](/decisions/download-variants.md), sobald implementiert.
* **Change**: Neues Zugriffssignal — Part-Links laufen über einen Redirect-Endpoint, der `lastDownloadedAt` stempelt und mit 302 auf eine frisch signierte S3-URL zeigt (Bytes weiterhin direkt aus S3, Presign-TTL 1 h → 15 min). Ohne ihn kann die API einen echten Download nicht von einem Seitenaufruf unterscheiden.
* **Change**: Foto-Löschung entfernt das S3-Objekt der betroffenen Parts **sofort** (statt das alte Objekt bis zum Reconcile weiter auszuliefern) — unter dem Lazy-Modell wäre dieses Fenster sonst unbegrenzt. Korrektheits-, keine Kostenregel.
* **Creation**: Monitoring-Konzept für die TTL-Justierung — Per-Event/Per-Variante-Zählstände in `DownloadJob` (überleben Pod-Restarts), als DB-gestützte Gauges exportiert (Kardinalität auf 30-Tage-aktive Events gedeckelt), plus Histogram `pixshar_archive_expiry_to_rebuild_seconds` und eine Grafana-Row „Archive Lifecycle" in **beiden** Dashboard-JSONs.
