---
type: Decision
title: Download-Varianten — Kompakt und Original
description: Jedes Event bietet zwei Archiv-Varianten an — Kompakt (Display-Bilder, 1920 px) und Original (voller Upload) — als zwei unabhängige DownloadJobs pro Event, per quality unterschieden. Seit Archiv-Lebenszeit (siehe /decisions/archive-lifetime.md) wird keine der beiden mehr eager gebaut; beide entstehen nur noch auf explizite Anforderung.
tags: [decision, download, quality, variants, archive, zip]
timestamp: 2026-07-12T00:00:00Z
---

> **Update (2026-07-12):** Diese Entscheidung beschrieb ursprünglich zwei Varianten, die **beide
> immer eager** gebaut wurden. [Archiv-Lebenszeit](/decisions/archive-lifetime.md) hat das
> Build-Verhalten seither auf **lazy** umgestellt: keine Variante wird mehr automatisch gebaut,
> weder beim Upload noch beim Öffnen der Downloadseite. Was hier bleibt — und weshalb dieses
> Dokument nicht einfach gelöscht wurde — ist die Entscheidung, dass es überhaupt **zwei**
> unabhängige Varianten gibt, wie die Variante auf dem `DownloadJob` statt auf dem Part lebt, und
> die S3-Schlüssel-/Orphan-Sweep-Trennung. Abschnitte, die das alte Eager-Verhalten beschrieben,
> sind unten korrigiert; Details zum Lazy-Build gehören in die neuere Entscheidung.

# Entscheidung

Jedes Event **kann** zwei Download-Varianten anbieten — Kompakt und Original —, die auf der
Downloadseite als Toggle erscheinen:

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
- **Trigger (aktueller Stand, siehe [Archiv-Lebenszeit](/decisions/archive-lifetime.md)
  für die Details)**: Weder Foto-Upload noch das Öffnen der Downloadseite legen einen Job an oder
  bauen eager. Ein Foto-Upload hängt eine neue Foto an **jede Variante an, die gerade lebt**
  (`READY`/`DEBOUNCING`/`QUEUED`/`BUILDING`) — eine Variante, die nie angefordert oder deren
  Bytes vom Idle-Reaper reklamiert wurden, bleibt unangetastet. Foto-Löschung reklamiert die
  betroffenen Parts **beider** Varianten sofort (nicht mehr nur `STALE` mit verzögertem
  Reconcile). Ein Job entsteht ausschließlich, wenn ein Gast oder Admin ihn explizit anfordert.
- **S3-Schlüssel** trägt die Variante: `{eventId}/archive/{quality}-part-{index}-g{generation}.zip`.
  Alt-Objekte (`gallery-part-…`) gelten als `ORIGINAL` und bleiben herunterladbar; der Orphan-Sweep
  ist variantengebunden und löscht nie die Objekte der anderen Variante.

Konsequenz: Ein Event, dessen Gäste **beide** Varianten aktiv herunterladen, hält zwei Sätze
Archiv-Parts lebendig — Archiv-Storage verdoppelt sich für dieses Event etwa, bis der Idle-Reaper
eine ungenutzte Variante reklamiert (siehe [Archiv-Lebenszeit](/decisions/archive-lifetime.md)).
Ein Event, dessen Gäste nur Kompakt anfordern, zahlt für Original gar nichts.

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
- `build-now` / `rebuild-all` / `cancel` / `release` sowie Admin-Status nehmen einen
  `quality`-Selektor (Default `ORIGINAL`) und wirken auf genau **eine** Variante.

# Nicht in dieser Iteration

- **`allowOriginalDownload`-Flag + SaaS-Preisstufen** (nur-Kompakt-Events, Originale gelöscht) —
  hängt an Billing-Logik, additive Migration.
- **E-Mail-Benachrichtigung** bei Build-Fertigstellung; **eigener** Kompressions-Tier abweichend
  von der Display-Auflösung; **Cloud-Export**-Variantenwahl (siehe
  [Cloud-Export](/concepts/cloud-export-google-dropbox.md)).

# Citations

[1] [Archive generation architecture](/architecture/archive-generation.md)
[2] [Download Jobs data model](/data-model/download-jobs.md)
[3] [Multi-part archive decision](/decisions/multi-part-archive.md)
[4] [Archiv-Lebenszeit decision](/decisions/archive-lifetime.md)
