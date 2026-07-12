---
type: Concept
title: Archiv-Lebenszeit — Lazy-Build und Idle-Expiry
description: Archive sind ein Cache, kein Artefakt — sie entstehen nur auf Anforderung, leben solange sie geladen werden, und werden nach TTL-Ablauf von S3 gelöscht. Membership überlebt, Bytes nicht.
tags: [concept, specced, zip, ttl, storage, archive, cost, monitoring]
status: specced — Tickets PIXSHAR-1 … PIXSHAR-9, noch nicht implementiert
timestamp: 2026-07-12T00:00:00Z
---

# Konzept

Ein Archiv ist ein **Cache, kein Artefakt**. Dauerhaft ist die **Membership** — welches Foto in
welchem Part liegt. Die ZIP-Bytes sind wegwerfbar: sie entstehen nur, wenn jemand sie anfordert,
und verschwinden wieder, wenn sie eine Zeit lang niemand geladen hat.

Heute baut jedes Event **beide** Varianten (Kompakt + Original) eager 60 s nach dem letzten Upload
— unabhängig davon, ob je ein Gast die Downloadseite öffnet. Einmal gebaut, liegen die Parts bis zur
Event-Löschung auf S3. ZIPs von JPEGs komprimieren praktisch nicht (store mode, ~1:1), also
verdoppeln die Archive den Speicherbedarf eines Events. Die Rechnung wächst monoton mit jedem je
gehosteten Event, während die tatsächliche Download-Aktivität sich auf die ersten Tage nach dem
Event konzentriert.

# Die Regeln

**Entstehen — lazy.** Foto-Uploads bauen nichts mehr. Eine Variante entsteht erst, wenn jemand sie
explizit anfordert: der Gast über einen „Archiv erstellen"-Button auf dem jeweiligen Tab
(`POST /api/gallery/:slug/download/request?quality=`), der Admin über „Jetzt bauen" (Pre-Warm, bevor
er den Link teilt). Ein Original-Archiv, das nie jemand will, wird **nie gebaut**. Das Öffnen der
Downloadseite ist ein Lesevorgang und löst keinen Build aus — der heutige `ensureJob`-Seiteneffekt
auf dem GET entfällt.

**Leben — eager aktuell halten.** Solange eine Variante `READY` ist, hängen neue Uploads wie bisher
per Debounce neue Parts an. Ist sie `EXPIRED` oder existiert sie nicht, passiert bei einem Upload
nichts — ein abgelaufenes Archiv wird durch Uploads **nie** wiederbelebt. Merksatz: *lazy beim
Erschaffen, eager beim Aktuellhalten.*

**Messen — der echte Download.** Die Part-Links zeigen auf
`GET /api/gallery/:slug/download/part/:index?quality=`, das `lastDownloadedAt` auf dem Job stempelt
und mit **302** auf eine frisch signierte S3-URL antwortet. Die Bytes fließen weiterhin direkt aus
S3 (die [Presigned-URL-Entscheidung](/decisions/presigned-urls.md) bleibt unangetastet). Ohne diesen
Umweg wüsste die API nur, dass die *Seite geöffnet* wurde — nicht, ob je ein Byte floss. Die
Presign-Gültigkeit sinkt auf 15 min: S3 prüft die Signatur beim Request-Start, ein laufender
Multi-GB-Transfer bricht also nicht ab.

**Sterben — idle, nicht alt.** Ein App-Reaper räumt Jobs ab, deren
`idleSince = COALESCE(lastDownloadedAt, readyAt)` älter als `DOWNLOAD_ARCHIVE_TTL_DAYS` ist
(Default **5**; `0` = nie ablaufen, altes Verhalten): S3-Objekte löschen, Job und Parts auf
`EXPIRED`, **Membership-Zeilen bleiben stehen**. Granularität ist die ganze Variante — Kompakt kann
leben, während Original verfällt.

**Wiederkommen.** Die nächste Anforderung baut aus der erhaltenen Membership dieselben Parts wieder
(gleicher `partIndex`, gleiche `membershipSig`, `generation + 1`) und hängt zwischenzeitlich
hochgeladene Fotos als neue Parts an. Die grünen Häkchen des zurückkehrenden Gasts überleben — genau
dafür wird die Membership aufgehoben. Parts werden einzeln committet, der Gast kann Teil 1 laden,
während Teil 4 noch baut.

# Warum kein S3-Lifecycle

Das ursprüngliche Konzept sah **S3-Lifecycle-Regeln** auf dem Prefix `{eventId}/archive/` vor. Das
ist widerlegt: S3-Expiry ist **altersbasiert**, nicht zugriffsbasiert. Eine Lifecycle-Regel würde ein
Archiv, das täglich heruntergeladen wird, nach N Tagen trotzdem löschen — genau das Gegenteil der
Anforderung. Nur ein anwendungseigener Reaper kann „seit N Tagen nicht geladen" ausdrücken, hält DB
und Bucket per Konstruktion konsistent und verhält sich auf AWS und MinIO identisch, ohne
Operator-Konfiguration.

Reihenfolge im Reaper: **erst Objekte löschen, dann Status kippen.** Ein Absturz dazwischen
hinterlässt einen EXPIRED-Job ohne Objekte (harmlos — die nächste Anforderung baut neu), niemals
einen READY-Job, der auf gelöschte Objekte zeigt (der Gäste mit 404 abwiese). Der Claim läuft per
CAS (`updateMany WHERE status = 'READY'`), damit zwei Replicas nie doppelt löschen — dasselbe Muster
wie beim bestehenden Stale-BUILDING-Reaper.

# Löschen bleibt sofort wirksam

Heute markiert das Löschen eines Fotos die betroffenen Parts `STALE`, während das **alte S3-Objekt
weiter ausgeliefert wird** (mit dem gelöschten Foto darin), bis der Reconcile es ~60 s später
ersetzt. Unter dem Lazy-Modell wird kein Build mehr angestoßen — dieses Fenster würde also
**unbegrenzt** offen bleiben.

Deshalb: beim Löschen eines Fotos verlieren die betroffenen Parts **sofort** ihr S3-Objekt und gehen
auf `EXPIRED`; die Membership wird um das gelöschte Foto bereinigt. Kein Build wird angestoßen; die
nächste Anforderung baut neu. Dies ist der einzige Pfad, der eine **teilweise verfügbare** Variante
erzeugt — die Payload trägt das bereits (`DownloadPart.url` ist nullable). Das ist eine
Korrektheits-, keine Kostenregel.

# Datenmodell

`DownloadJob` bekommt:

| Feld | Zweck |
|---|---|
| `lastDownloadedAt` | Idle-Uhr; gestempelt vom Part-Redirect-Endpoint |
| `readyAt` | Startpunkt der Uhr für ein nie geladenes Archiv |
| `expiredAt` | speist das Ablauf→Rebuild-Histogram |
| `expiryCount` | wie oft der Reaper dieses (Event, Variante) getroffen hat |
| `rebuildCount` | wie oft neu gebaut wurde |

`DownloadJobStatus` bekommt `EXPIRED`; `DownloadArchivePart.status` (heute freier String) ebenso —
Zeile und Membership intakt, Objekt weg. **Keine neue Tabelle.**
[`DownloadArchivePart`](/data-model/download-jobs.md) und `DownloadArchivePartEntry` werden zum
dauerhaften Kern des Features.

Zustandsmaschine:

```
DEBOUNCING → QUEUED → BUILDING → READY → EXPIRED
                 ↑                           │
                 └────── Anforderung ────────┘
```

`READY → EXPIRED` verursachen: Reaper (idle), Admin-„Freigeben", Foto-Löschung (nur Parts).
`EXPIRED → QUEUED` verursacht **ausschließlich** eine explizite Anforderung.

# Monitoring

Die TTL von 5 Tagen ist eine Schätzung. Sie wird erst justierbar, wenn sichtbar ist, **welches Event
der Reaper wie oft trifft**, **wie oft je Variante neu gebaut wird** und — entscheidend — **wie
schnell nach einem Ablauf die nächste Anforderung kommt**.

| Metrik | Typ | Labels | Beantwortet |
|---|---|---|---|
| `pixshar_archive_expiries` | Gauge (aus DB) | `event`, `quality` | Welches Event trifft der Reaper wie oft |
| `pixshar_archive_rebuilds` | Gauge (aus DB) | `event`, `quality` | Welches Event wird wie oft neu gebaut |
| `pixshar_archive_live_bytes` | Gauge | `quality` | Was das Archiv gerade auf S3 kostet |
| `pixshar_archive_bytes_reclaimed_total` | Counter | `quality` | Wie viel der Reaper freigeräumt hat |
| `pixshar_archive_expired_total` | Counter | `quality` | Reaper-Treffer gesamt |
| `pixshar_archive_builds_total` | Counter | `quality`, `trigger` | Gewollte Arbeit vs. Thrash |
| `pixshar_archive_expiry_to_rebuild_seconds` | Histogram | `quality` | **Ist die TTL zu kurz?** |

`trigger` ∈ `first_build | on_demand_rebuild | append | admin`. Das Histogram (Buckets 1 h / 6 h /
1 d / 3 d / 7 d / 14 d / 30 d) ist die einzige Metrik, die die TTL-Frage direkt beantwortet: ein
dickes linkes Ende heißt „der Reaper schneidet in aktive Nutzung, TTL erhöhen".

**Warum die beiden Per-Event-Serien DB-gestützte Gauges sind und keine Prom-Counter:** Ablauf und
Rebuild sind pro Event *seltene* Ereignisse, deren Wert in der Historie über Wochen liegt.
In-Process-Counter werden bei jedem Pod-Restart auf 0 zurückgesetzt — sie löschen genau die
Historie, gegen die justiert werden soll. Die Zählstände leben daher in `DownloadJob`; der Exporter
spiegelt sie beim Scrape (Muster von `photosByStatus`: Aggregat-Query in `collect()`, `reset()` vor
`set()`), beschränkt auf Events mit Aktivität in den letzten 30 Tagen — das **deckelt die
Kardinalität**, statt sie mit jedem je gehosteten Event wachsen zu lassen. Das `event`-Label trägt
den Slug, damit Grafana lesbar bleibt.

Dashboard: neue Row **„Archive Lifecycle"** auf dem bestehenden Pixshar-Overview — Live-Bytes je
Variante, freigegebene Bytes im Zeitraum, Reaper-Treffer und Rebuilds pro Stunde, p50/p90 von
Ablauf→Rebuild, Builds nach Trigger und eine Tabelle **„Top-Events nach Rebuilds"**. Das
Dashboard-JSON existiert **zweimal** (`monitoring/grafana/dashboards/` für Compose,
`helm/pixshar/dashboards/` für die ConfigMap) — beide bekommen die Row, sie dürfen nicht
auseinanderlaufen.

# Rollout

Die Migration setzt `lastDownloadedAt = now()` für jeden bestehenden `READY`-Job. Damit startet die
Uhr für jedes Bestandsarchiv beim Deploy neu: wer es in den nächsten fünf Tagen nutzt, hält es am
Leben, der Rest fällt danach weg. Kein laufendes Event verliert sein Archiv von einer Sekunde auf
die andere.

# Nicht in dieser Iteration

- **TTL pro Event oder pro Preisstufe** und ein „dauerhaft bereithalten"-Pin am Event. Erst eine
  globale TTL; die Metriken zeigen, ob feinere Steuerung überhaupt gebraucht wird.
- **S3-Lifecycle als Waisen-Backstop** (großzügige altersbasierte Regel zusätzlich zum Reaper) —
  denkbar, aber vorerst zwei Löschpfade zu viel.
- **E-Mail-Benachrichtigung**, wenn ein angeforderter Build fertig ist.
- **Repacking/Defragmentieren** der Parts beim Rebuild — die Membership-Erhaltung ist der Zweck.
- **Löschen der Original-/Display-Quellobjekte** (Basic/Premium-Tier, siehe
  [KEDA Worker Scaling](/concepts/keda-worker-scaling.md)) und jede Billing-Logik.

# Citations

[1] [Archive generation architecture](/architecture/archive-generation.md)
[2] [Multi-part archive decision](/decisions/multi-part-archive.md)
[3] [Download-Varianten](/decisions/download-variants.md)
[4] [Download Jobs data model](/data-model/download-jobs.md)
[5] [Presigned URLs](/decisions/presigned-urls.md)
