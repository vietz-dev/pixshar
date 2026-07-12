# Concepts

Ideas and approaches that have been thought through but not yet implemented.
A concept becomes a [Decision](/decisions/) once it is built and shipped.

* [KEDA Worker Scaling](keda-worker-scaling.md) - Scale-to-zero for resize and ZIP-builder workers in hosted SaaS via KEDA Postgres queue-depth triggers
* [Archiv-Lebenszeit](zip-ttl-storage.md) - Archive als Cache: Build nur auf Anforderung, Idle-Expiry durch einen App-Reaper (kein S3-Lifecycle), Rebuild aus erhaltener Membership, plus Monitoring zum Justieren der TTL — specced als PIXSHAR-1 … PIXSHAR-9
* [Cloud-Export Google Fotos & Dropbox](cloud-export-google-dropbox.md) - Serverseitiger Direkttransfer in die Cloud-Bibliothek des Gastes; API-Vergleich aller Plattformen, Apple-Limitierung, Referenzimplementierung Pixieset
