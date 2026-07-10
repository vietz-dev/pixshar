---
type: Decision
title: Download-Varianten — Kompakt und Original
description: Jedes Event bietet zwei Archiv-Varianten, die beide immer gebaut und angeboten werden — Kompakt (Display-Bilder, 1920 px) und Original (voller Upload). Zwei unabhängige DownloadJobs pro Event, per quality unterschieden.
tags: [decision, download, quality, variants, archive, zip]
timestamp: 2026-07-11T00:00:00Z
---

# Entscheidung

Jedes Event bietet **zwei Download-Varianten** an, die **beide immer** gebaut und auf der
Downloadseite angeboten werden:

| Variante | Inhalt | Quelle |
|---|---|---|
| **Kompakt** (`DISPLAY`) | Display-Bilder, 1920 px / JPEG q85 | vorhandener Display-Key in S3 |
| **Original** (`ORIGINAL`) | Upload in voller Auflösung | Original-Key in S3 |

Der Original-Download ist der Gründungszweck der Anwendung; ein Teil der Gäste wollte jedoch eine
kleinere, schnell ladbare Variante. Statt pro Event zu entscheiden, werden **beide** angeboten —
so sind beide Lager zufrieden, ohne Konfiguration pro Event. Kompakt ist der Gast-Default;
Original ist ein bewusstes Opt-in.

# Variante lebt auf dem Job

Die Variante ist eine Eigenschaft des **DownloadJobs**, nicht der einzelnen Part-Zeile — denn der
Job ist die vom Worker atomar beanspruchte Einheit (`QUEUED→BUILDING` CAS). Ein Worker baut pro
Claim genau **ein** Archiv. Damit Kompakt und Original unabhängig von verschiedenen Workern gebaut
werden können, sind sie **zwei getrennte Jobs**:

- `DownloadJob` trägt `quality: ArchiveQuality` (`DISPLAY | ORIGINAL`), Default `ORIGINAL`.
- Eindeutigkeit ist `(eventId, quality)` — bis zu zwei Jobs pro Event.
- Parts erben die Variante über ihren Job (kein eigenes `quality`-Feld).
- Migration Bestandsdaten: der alte Builder zippte Originale, also sind bestehende Jobs faktisch
  `ORIGINAL` → der Default deckt sie ab, kein Daten-Rewrite.

# Build-Lebenszyklus

- **Kompakt reuse Display-Bilder** — zippt die bereits beim Upload erzeugten 1920-px-Objekte.
  Keine neue Bildvariante, keine Pipeline-Änderung, kein zusätzlicher Quell-Storage. Bewusst
  akzeptierte Kopplung: die Kompakt-Qualität hängt an der Display-Auflösung.
- **Trigger-Fan-out**: Foto-Upload enqueued **beide** Jobs; Foto-Löschung markiert die betroffenen
  Parts **beider** Jobs STALE. Debounce/Reconcile arbeiten je Variante getrennt.
- **Lazy für Bestandsevents**: Events, die es vor der Einführung schon gab, haben nur ein
  Original-Archiv. Der Kompakt-Job entsteht **lazy** beim ersten Gast-Aufruf der Downloadseite
  (bzw. der nächsten Foto-Aktivität) — kein Massen-Backfill, der den Worker-Pool überrennen würde.
- **S3-Schlüssel** trägt die Variante: `{eventId}/archive/{quality}-part-{index}-g{generation}.zip`.
  Alt-Objekte (`gallery-part-…`) gelten als `ORIGINAL` und bleiben herunterladbar; der Orphan-Sweep
  ist variantengebunden und löscht nie die Objekte der anderen Variante.

Konsequenz: Aktive Events treiben **zwei** Builds und speichern zwei Sätze Archiv-Parts →
Archiv-Storage und Queue-Tiefe verdoppeln sich etwa, bis TTL greift (siehe unten).

# Gast-UI

Segmented Toggle `[ Kompakt ] [ Original ]` — es wird immer nur **eine** Part-Liste gerendert
(Galerien haben 7+, potenziell 20+ Parts). Kompakt ist immer der Default-Tab, auch während es noch
gebaut wird; es wird **nicht** automatisch auf Original umgeschaltet. Jeder Tab trägt eine eigene
Zusammenfassung (Teile-Anzahl, Größe), einen Build-Indikator und ein „building…"-Banner. Die
„heruntergeladen"-Häkchen pro Part werden **pro Variante** getrackt (Quality-Segment im
localStorage-Key).

# Admin-UI

**Zwei Panels pro Variante** (Kompakt / Original), jedes mit eigenem SSE-Status und eigenen Aktionen
Build-now / Rebuild-all / Cancel. So kann der Admin nur das günstige Kompakt-Archiv neu bauen, ohne
den teuren Original-Rebuild anzustoßen. Kein zusammengefasster Status (mehrdeutig, wenn eine
Variante READY und die andere BUILDING ist).

# API

- `GET /api/gallery/:slug/download` liefert **beide** Varianten in einer Antwort (`defaultQuality`
  = DISPLAY, `variants.{DISPLAY,ORIGINAL}`); die Default-Variante ist zusätzlich zur Abwärtskompat
  auf oberster Ebene gespiegelt.
- Guest- und Admin-SSE-Streams senden Status je Variante.
- `build-now` / `rebuild-all` / `cancel` sowie Admin-Status nehmen einen `quality`-Selektor
  (Default `ORIGINAL`) und wirken auf genau **eine** Variante.

# Nicht in dieser Iteration

- **TTL / Lazy-Expiry** der gebauten Archive — der Haupthebel gegen die verdoppelte Storage-Last,
  Folgephase (siehe [ZIP TTL Konzept](/concepts/zip-ttl-storage.md)).
- **`allowOriginalDownload`-Flag + SaaS-Preisstufen** (nur-Kompakt-Events, Originale gelöscht) —
  hängt an Billing-Logik, additive Migration.
- **E-Mail-Benachrichtigung** bei Build-Fertigstellung; **eigener** Kompressions-Tier abweichend
  von der Display-Auflösung; **Cloud-Export**-Variantenwahl (siehe
  [Cloud-Export](/concepts/cloud-export-google-dropbox.md)).

# Citations

[1] [Archive generation architecture](/architecture/archive-generation.md)
[2] [Download Jobs data model](/data-model/download-jobs.md)
[3] [Multi-part archive decision](/decisions/multi-part-archive.md)
