# Concepts

Ideas and approaches that have been thought through but not yet implemented.
A concept becomes a [Decision](/decisions/) once it is built and shipped.

* [KEDA Worker Scaling](keda-worker-scaling.md) - Scale-to-zero for resize and ZIP-builder workers in hosted SaaS via KEDA Postgres queue-depth triggers
* [ZIP TTL Storage](zip-ttl-storage.md) - Expire archive parts via S3 lifecycle rules, rebuild lazily on next request — halves storage footprint for hosted SaaS
* [Cloud-Export Google Fotos & Dropbox](cloud-export-google-dropbox.md) - Serverseitiger Direkttransfer in die Cloud-Bibliothek des Gastes; API-Vergleich aller Plattformen, Apple-Limitierung, Referenzimplementierung Pixieset
