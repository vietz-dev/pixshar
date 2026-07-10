---
type: Concept
title: Download-Varianten — Kompakt und Original immer verfügbar
description: Jedes Event bietet zwei Archiv-Varianten an, die beide immer gebaut und angeboten werden — Kompakt (Display-Variante, 1920 px) und Original (voller Upload). Zwei unabhängige DownloadJobs pro Event, per quality unterschieden. Kein Event-Flag in dieser Iteration.
tags: [concept, download, quality, variants, archive, zip, presigned-url, download-job, lazy-build]
status: geplant — Umsetzung als Nächstes
timestamp: 2026-07-09T00:00:00Z
---

# Konzept

Jedes Event bietet **zwei Download-Varianten** an, die **beide immer** gebaut und auf der
Downloadseite angeboten werden:

| Variante | Inhalt | Quelle |
|---|---|---|
| **Kompakt** | Display-Variante, 1920 px / JPEG q85 | vorhandener `displayKey` in S3 |
| **Original** | Upload in voller Auflösung | `originalKey` in S3 |

Hintergrund: Der Original-Download ist der Gründungszweck der Anwendung. Ein Teil der Gäste hat
jedoch nach einer kleineren, schnell ladbaren Variante gefragt. Statt pro Event zu entscheiden
welche Qualität angeboten wird, werden **beide Varianten immer** angeboten — so sind beide Lager
zufrieden, ohne eine Konfigurationsentscheidung pro Event.

## Kein Flag in dieser Iteration

Ein früher Entwurf sah ein Event-Flag `allowOriginalDownload` vor. Da nun **beide** Varianten
immer verfügbar sind, ist das Flag zur Befriedigung beider Gruppen überflüssig. Ein Flag
lohnt sich erst für einen anderen Zweck — Storage sparen / SaaS-Preisstufen (nur-Kompakt-Events,
deren Originale nicht dauerhaft vorgehalten werden). Dieser Zweck ist eigenständig, hängt an
noch nicht konzipierter Billing-Logik und wird **später** nachgezogen. Die Wiedereinführung des
Flags ist eine additive Migration.

# Datenmodell

Die Variante ist eine Eigenschaft des **DownloadJobs**, nicht der einzelnen Part-Zeile — denn der
Job ist die vom Worker beanspruchte Einheit (`claimJob` macht ein atomares `QUEUED→BUILDING` CAS
pro Job). Ein Worker baut pro Claim genau **ein** Archiv. Damit Kompakt und Original unabhängig
von verschiedenen Workern gebaut werden können, müssen sie **zwei getrennte Jobs** sein.

```prisma
enum ArchiveQuality {
  DISPLAY
  ORIGINAL
}

model DownloadJob {
  // ... bestehende Felder ...
  quality ArchiveQuality @default(ORIGINAL)

  // War: @@unique([eventId])
  @@unique([eventId, quality])
}
```

- `DownloadArchivePart` bekommt **kein** `quality`-Feld — Parts erben die Variante über ihren Job.
- **Migration Bestandsdaten**: Der heutige Builder zippt aus `originalKey`, d.h. bestehende Jobs
  sind faktisch Original → `quality = ORIGINAL` als Default deckt die Migration ab. Für Kompakt
  entsteht der Job **lazy** (siehe unten), es wird nichts vorab gebaut.

# Build-Lebenszyklus

## Kompakt nutzt die vorhandene Display-Variante

Die Kompakt-Variante zippt die bereits existierenden `displayKey`-Objekte (1920 px / q85,
`imageProcessor.ts` erzeugt sie beim Upload). **Keine neue Bildvariante, keine Änderung an der
Bildpipeline, kein zusätzlicher Storage für Quellbilder** — die Bytes liegen schon in S3.

Konsequenz-Kopplung (bewusst akzeptiert): Die Kompakt-Qualität ist an die Display-Auflösung
gebunden. Wird die Display-Auflösung fürs Lightbox je erhöht, wächst der Kompakt-Download mit.

## Zwei unabhängige Queue-Einträge

- **Trigger-Fan-out**: Foto-Upload → **beide** Jobs (DISPLAY + ORIGINAL) werden enqueued.
  Foto-Löschung → die betroffenen Parts **beider** Jobs werden STALE.
- Beide Jobs sind eigenständige Queue-Einträge, jeder wird von einem freien Worker beansprucht,
  ein Archiv pro Claim. Skalierung wie gehabt: mehr Worker = schneller. Es gibt **keinen** Zwang,
  Kompakt und Original zeitgleich zu bauen — sie können Minuten auseinander oder nie gleichzeitig
  laufen.

## Lazy für Bestandsevents

Für Events, die es vor Einführung schon gibt (inkl. des aktiv genutzten Events), existiert nur das
Original-Archiv. Der **Kompakt-Job entsteht lazy**: beim ersten Aufruf der Downloadseite bzw. der
nächsten Foto-Aktivität wird er enqueued, ein Worker baut ihn, kurz darauf erscheint das Archiv.
Kein Massen-Backfill — der würde für jedes historische Event gleichzeitig einen Build auslösen und
den bewusst knappen Worker-Pool überrennen.

## S3-Schlüssel

Der Variantenname wandert in den Key:
```
{eventId}/archive/{quality}-part-{partIndex}-g{generation}.zip
```
(bisher: `{eventId}/archive/gallery-part-{partIndex}-g{generation}.zip`).

## Storage-Konsequenz

Ab sofort treiben aktive Events **zwei** Builds und speichern **zwei** Sätze Archiv-Parts
(Kompakt + Original) → Archiv-Storage und Queue-Tiefe verdoppeln sich etwa, bis TTL greift
(siehe unten).

# Gast-UI — `gallery/[slug]/download`

**Segmented Toggle** `[ Kompakt ] [ Original ]` — es wird immer nur **eine** Part-Liste gerendert.
Das löst das Längenproblem: Galerien haben heute schon 7+ Parts, potenziell 20+, und zwei volle
Listen übereinander würden das verdoppeln.

- **Kompakt ist immer der Default-Tab** — auch wenn es gerade noch gebaut wird. Es wird **nicht**
  automatisch auf Original umgeschaltet. Original ist eine bewusste Opt-in-Entscheidung des Gasts.
- Ein laufender Build auf dem aktiven Tab ist okay, wird aber **transparent** über das bestehende
  „building…"-Banner dargestellt.
- Jeder Tab trägt eine kleine Zusammenfassung (Teile-Anzahl, Größe) und ggf. einen Build-Indikator.
- Die „heruntergeladen"-Häkchen pro Part werden **pro Variante** getrackt — der localStorage-Key
  bekommt ein Quality-Segment (sonst kollidieren Kompakt-Part-1 und Original-Part-1).

# Admin-UI — `DownloadPanel`

**Zwei Panels pro Variante** (Kompakt / Original), jedes mit eigenem SSE-Status und eigenen Aktionen
**Build-now / Rebuild-all / Cancel**. So kann der Admin z.B. nur das günstige Kompakt-Archiv neu
bauen, ohne den teuren Original-Rebuild über 20 Parts anzustoßen. Kein zusammengefasster Status
(wäre mehrdeutig, wenn Original READY und Kompakt BUILDING ist).

# API-Auswirkungen

- `GET /api/gallery/:slug/download` gibt **beide** Varianten in einer Antwort zurück (eine
  Runde, damit die Tab-Labels beide Zusammenfassungen haben).
- `GET /api/gallery/:slug/download/stream` (SSE) — analog, Status je Variante.
- Admin-Status-Stream — je Variante ein Job.

# Interaktion mit anderen Konzepten

## ZIP TTL Storage (Folgephase)

TTL auf die gebauten Archive wird **nachträglich** ergänzt und ist der Haupthebel gegen die
verdoppelte Storage-Last aus diesem Konzept. Details im [ZIP TTL Konzept](/concepts/zip-ttl-storage.md):
Parts verfallen per S3-Lifecycle und werden bei nächster Anfrage lazy neu gebaut. In dieser
Iteration **nicht** umgesetzt, aber im Modell vorgesehen.

## KEDA Worker Scaling

Der ZIP-Builder erhält im Kontext des [KEDA-Konzepts](/concepts/keda-worker-scaling.md) zwei
Job-Varianten in derselben Queue (DISPLAY + ORIGINAL), die per Queue-Tiefe skaliert werden.

## Cloud-Export (Google Fotos / Dropbox)

Der [Cloud-Export](/concepts/cloud-export-google-dropbox.md) kann später derselben Logik folgen:
Default-Export der Kompakt-Variante, Original-Transfer als Opt-in.

# Zukünftige Erweiterungen (nicht in dieser Iteration)

- **E-Mail-Benachrichtigung** bei Build-Fertigstellung, damit Gäste nicht auf der Seite warten
  müssen — freiwillig, eigenes kleines Konzept.
- **`allowOriginalDownload`-Flag + SaaS-Preisstufen** — nur-Kompakt-Events, deren Originale nach
  dem Kompakt-Build aus S3 gelöscht werden (Storage-Ersparnis ~0.5×). Additive Migration.

# Was heute bereits passt

- Display-Varianten (`display.jpg`, 1920 px / q85) werden beim Upload erzeugt und in S3 gehalten.
- Die Part-Architektur (`DownloadArchivePart`, stabile `partIndex`, `generation`, `membershipSig`)
  ist bereits mehrteilig und rebuild-fähig — das `quality`-Feld auf dem Job ist additiv.
- Presigned URLs, SSE-Status-Streams und die localStorage-Download-Verfolgung existieren bereits
  und werden nur um die Variantendimension erweitert.
</content>
</invoke>
