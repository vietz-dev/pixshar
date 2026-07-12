---
type: Decision
title: Archiv-Lebenszeit — Lazy-Build und Idle-Expiry
description: Ein Archiv ist ein Cache, kein Artefakt. Es entsteht nur auf Anforderung, hält sich aktuell solange es lebt, und ein App-Reaper reklamiert seine S3-Objekte nach DOWNLOAD_ARCHIVE_TTL_DAYS Idle-Zeit — die Membership überlebt, die Bytes nicht.
tags: [decision, archive, zip, ttl, storage, cost, monitoring, expiry]
timestamp: 2026-07-12T00:00:00Z
---

# Entscheidung

Ein Archiv ist ein **Cache, kein Artefakt**. Dauerhaft ist die **Membership** — welches Foto in
welchem Part liegt (`DownloadArchivePart` + `DownloadArchivePartEntry`). Die ZIP-Bytes sind
wegwerfbar: sie entstehen nur, wenn jemand sie anfordert, und verschwinden wieder, wenn sie eine
Zeit lang niemand geladen hat.

Vorher baute jedes Event **beide** Varianten (Kompakt + Original, siehe
[Download-Varianten](/decisions/download-variants.md)) eager 60 s nach dem letzten Upload —
unabhängig davon, ob je ein Gast die Downloadseite öffnet. Einmal gebaut, lagen die Parts bis zur
Event-Löschung auf S3. ZIPs von JPEGs komprimieren praktisch nicht (store mode, ~1:1), also
verdoppelten die Archive den Speicherbedarf eines Events, und die Rechnung wuchs monoton mit jedem
je gehosteten Event, während sich die tatsächliche Download-Aktivität auf die ersten Tage nach dem
Event konzentriert. Ein Original-Archiv insbesondere ist ein bewusstes Opt-in — ein großer Teil
davon wird nie abgerufen und war reine Kostenlast.

# Die Regeln

**Entstehen — lazy.** Foto-Uploads bauen nichts mehr. Eine Variante entsteht erst, wenn jemand sie
explizit anfordert: der Gast über `POST /api/gallery/:slug/download/request?quality=` (den
„Archiv erstellen"-Button auf dem jeweiligen Tab), der Admin über „Jetzt bauen" (`build-now`,
Pre-Warm vor dem Teilen des Links). `requestBuild` in
`apps/api/src/services/downloadJob/triggers.ts` ist der **einzige** Einstiegspunkt, der einen Job
anlegt — Gast-Endpoint und Admin-Pre-Warm rufen beide dieselbe Funktion, damit State Machine und
Metrik-Zählung genau eine Heimat haben. Das Öffnen der Downloadseite (`GET /download`) ist reiner
Lesevorgang und löst **keinen** Build mehr aus — der frühere `ensureJob`-Seiteneffekt auf dem GET
wurde entfernt (`buildBothVariantsPayload` in `payload.ts` ist jetzt ein reiner Read).

**Leben — eager aktuell halten.** Solange eine Variante lebt (`READY`, `DEBOUNCING`, `QUEUED` oder
`BUILDING` — die `ALIVE_STATUSES`-Liste in `triggers.ts`), hängt `triggerDebounceAllVariants` neue
Uploads wie bisher per Debounce als neue Parts an. Ist sie `EXPIRED` oder existiert sie nicht,
passiert bei einem Upload nichts — ein abgelaufenes Archiv wird durch Uploads **nie**
wiederbelebt. Merksatz: *lazy beim Erschaffen, eager beim Aktuellhalten.*

**Messen — der echte Download.** Die Part-Links auf der Gast-Downloadseite zeigen nicht mehr auf
S3, sondern auf `GET /api/gallery/:slug/download/part/:index?quality=`
(`registerPartDownload` in `payload.ts`). Der Endpoint stempelt `lastDownloadedAt` auf dem Job und
antwortet mit **302** auf eine frisch signierte S3-URL. Die Bytes fließen weiterhin direkt aus S3
— die [Presigned-URL-Entscheidung](/decisions/presigned-urls.md) bleibt unangetastet, nur die
Indirektionsebene ist neu. Ohne diesen Umweg wüsste die API nur, dass die *Seite geöffnet* wurde,
nicht, ob je ein Byte floss — ein Gast, der die Downloadseite offen lässt und nie klickt, hätte
das Archiv unbegrenzt am Leben gehalten. Die Presign-Gültigkeit sinkt dabei von 1 h auf 15 min
(`ARCHIVE_PART_PRESIGN_SECONDS`): S3 prüft die Signatur nur beim Request-*Start*, ein laufender
Multi-GB-Transfer bricht also nicht ab, wenn das Fenster währenddessen verstreicht.

**Sterben — idle, nicht alt.** Der Reaper (`apps/api/src/services/downloadJob/reaper.ts`) räumt
Jobs ab, deren `idleSince = COALESCE(lastDownloadedAt, readyAt)` älter als
`DOWNLOAD_ARCHIVE_TTL_DAYS` ist (Default **5**; `0` = nie ablaufen, altes Verhalten). Granularität
ist die ganze (Event, Variante) — alle ihre Parts gehen gemeinsam auf `EXPIRED`; Foto-Löschung ist
die einzige Ausnahme, die individuelle Parts reklamiert (siehe unten).

**Wiederkommen.** Die nächste Anforderung (`requestBuild`, Zustand `EXPIRED`/`FAILED`/`CANCELLED`)
baut aus der erhaltenen Membership dieselben Parts wieder (`builder.ts` behandelt `EXPIRED`-Parts
identisch zu `STALE`-Parts: gleicher `partIndex`, gleiche `membershipSig`, `generation + 1`) und
hängt zwischenzeitlich hochgeladene Fotos als neue Parts an. Die grünen Häkchen des
zurückkehrenden Gasts überleben, weil sie auf `membershipSig` beruhen, nicht auf einem Build-
Zähler — genau dafür wird die Membership aufgehoben.

# Die Reihenfolge-Regel — der subtilste Teil

Sowohl der Reaper (`expireArchive` in `reaper.ts`) als auch die Foto-Löschung
(`expirePartsForDeletedPhotos` in `deletion.ts`) müssen zwei Dinge tun, die nicht gleichzeitig
passieren können: die betroffenen Zeilen auf `EXPIRED` kippen, und die S3-Objekte löschen. Die
Reihenfolge dieser zwei Schritte ist die Regel, die das Code-Review als einzigen echten Bug in
dieser Epic gefunden hat:

**Erst die Zeilen auf EXPIRED kippen (in derselben Transaktion wie der CAS-Claim des Jobs), dann
erst die S3-Objekte löschen.**

`expireArchive` claimt den Job per `updateMany WHERE status = 'READY'` (damit zwei Replicas nie
denselben Job doppelt reklamieren) und liest im selben Statement die aktuell live-referenzierten
Keys, **bevor** es die Part-Zeilen auf `EXPIRED` setzt — danach sagt jede Zeile `EXPIRED`, egal ob
das Objekt noch existiert. Erst nach dem Commit dieser Transaktion werden die S3-Objekte gelöscht.

Diese Reihenfolge bedeutet: **jeder Absturzpunkt** — zwischen Claim und Löschung, während der
Löschung, nach erschöpften Lösch-Retries — hinterlässt `EXPIRED`-Zeilen, deren Objekte
möglicherweise noch existieren. Das ist die **harmlose** Richtung: nichts wird aus ihnen
ausgeliefert (`partHasObject`/`jobHoldsObjects` gaten sowohl das Payload als auch den
Part-Redirect-Endpoint auf den Zeilenstatus, nicht auf die Objekt-Existenz), der Builder holt sich
`EXPIRED`-Parts beim nächsten Build als Arbeit ab und baut sie bei `generation + 1` neu, und der
Orphan-Sweep am Ende jedes Builds räumt die liegengebliebenen Alt-Objekte ein.

Die verbotene Richtung ist die umgekehrte: **niemals** eine `READY`-Zeile, die auf ein bereits
gelöschtes Objekt zeigt. Würde man zuerst löschen und danach den Status kippen, hinterließe ein
Absturz dazwischen genau das — ein Gast würde vom Part-Redirect-Endpoint einen 302 auf einen toten
S3-Key bekommen (`NoSuchKey`). Die Kommentare in `reaper.ts` und `deletion.ts` nennen das
ausdrücklich die Invariante, die die Epic erzwingt: *ein Part-Row ist nie `READY`, während sein
Objekt weg ist.*

`deletion.ts` folgt demselben Prinzip, gespiegelt: dort ist es nicht der Job-Claim, der die
Sichtbarkeit steuert, sondern die einzelne Part-Zeile selbst (`EXPIRED` ⇒ kein Objekt). Beide
Module — Reaper und Deletion — committen die Zeilenänderung in einer Transaktion, bevor
`deleteS3Objects` aufgerufen wird.

# Foto-Löschung bleibt sofort wirksam

Vor dieser Epic markierte das Löschen eines Fotos die betroffenen Parts `STALE`, während das
**alte S3-Objekt weiter ausgeliefert wurde** (mit dem gelöschten Foto darin), bis der nächste
Reconcile es ersetzte. Unter dem Lazy-Modell wird kein Build mehr automatisch angestoßen — dieses
Fenster bliebe also **unbegrenzt** offen, bis zufällig ein Gast einen Rebuild anfordert. Das wäre
ein Korrektheitsbruch: „gelöscht" muss „gelöscht" bedeuten.

Deshalb verlieren die betroffenen Parts beim Löschen eines Fotos **sofort** ihr S3-Objekt und gehen
auf `EXPIRED` (`expirePartsForDeletedPhotos`, über **beide** Qualitäts-Varianten hinweg); ihre
Membership wird um das gelöschte Foto bereinigt. Ein Part, dessen letztes Mitglied gelöscht wurde,
wird komplett entfernt (Zeile + Entries), statt als leere `EXPIRED`-Hülle liegen zu bleiben — die
übrigen Parts behalten ihren `partIndex` unverändert (Lücken bleiben erlaubt). Kein Build wird
angestoßen; die nächste explizite Anforderung baut aus der bereinigten Membership neu (gleicher
`partIndex`, **neue** `membershipSig`, da sich der Inhalt echt geändert hat). Parts ohne das
gelöschte Foto bleiben unangetastet und downloadbar — dies ist der einzige Pfad, der eine
**teilweise verfügbare** Variante erzeugt (`DownloadPart.url` ist nullable, siehe
[Multi-part archive](/decisions/multi-part-archive.md)). Das ist eine Korrektheits-, keine
Kostenregel.

# Reaper-Details

- **CAS-Claim**, sicher unter mehreren Replicas: `updateMany WHERE status = 'READY'` — dasselbe
  Muster wie beim bestehenden Stale-BUILDING-Reaper (siehe
  [Durable Queue](/decisions/durable-queue.md)).
- Die periodische Sweep-Funktion (`sweepExpiredArchives`) läuft alle
  `DOWNLOAD_ARCHIVE_SWEEP_SECONDS` (Default 3600 s) und ist bei `DOWNLOAD_ARCHIVE_TTL_DAYS=0`
  vollständig deaktiviert (`startExpiryReaper` startet gar nicht erst).
- Die Admin-Aktion „Freigeben" (`POST /api/events/:id/download/release?quality=`) ruft **dieselbe**
  `expireArchive`-Funktion wie der periodische Sweep — kein zweiter Code-Pfad, der aus dem Takt
  geraten könnte.
- Beim Reklamieren wird `lastDownloadedAt` auf `null` zurückgesetzt: die Idle-Uhr der *nächsten*
  Inkarnation muss bei ihrem eigenen `readyAt` neu starten, sonst würde der wiederaufgebaute
  Archiv beim allernächsten Sweep sofort wieder als abgelaufen gelten.

# Rejected: S3-Lifecycle-Regeln

Die naheliegende Alternative — eine S3-Lifecycle-Regel auf `{eventId}/archive/`, die Objekte nach
N Tagen löscht — wurde verworfen. **S3-Expiry ist altersbasiert, nicht zugriffsbasiert.** Eine
Lifecycle-Regel würde ein Archiv, das täglich heruntergeladen wird, nach N Tagen trotzdem
löschen — genau das Gegenteil der Anforderung ("nicht heruntergeladen für N Tage", nicht "älter als
N Tage"). Nur ein anwendungseigener Reaper kann echte Idle-Zeit ausdrücken, hält DB und Bucket per
Konstruktion konsistent (die Membership-Zeilen wissen, was gelöscht wurde) und verhält sich auf AWS
und MinIO identisch, ohne bucket-seitige Operator-Konfiguration. Eine großzügige altersbasierte
Lifecycle-Regel als reiner Waisen-Backstop zusätzlich zum Reaper bleibt denkbar, wurde aber
bewusst nicht mitgeliefert — zwei Löschpfade für dasselbe Problem, bevor der eine erprobt ist.

# Datenmodell

`DownloadJob` bekommt `lastDownloadedAt`, `readyAt`, `expiredAt` (nullable Timestamps) sowie
`expiryCount`/`rebuildCount` (Int, Default 0) — letztere leben in der DB statt im Prozessspeicher,
damit sie Pod-Restarts überleben (siehe Monitoring unten). `DownloadJobStatus` bekommt `EXPIRED`;
`DownloadArchivePart.status` (bereits ein freier String) ebenso. Keine neue Tabelle — die Migration
`20260712002000_archive_expiry` fügt nur Spalten hinzu und backfillt
`lastDownloadedAt = now()` für jeden bestehenden `READY`-Job, damit jedes Bestandsarchiv beim
Deploy eine volle TTL-Schonfrist bekommt, statt sofort beim ersten Sweep zu verfallen.

Zustandsmaschine:

```
DEBOUNCING → QUEUED → BUILDING → READY → EXPIRED
                          ↑                   │
                          └─── Anforderung ───┘
```

`READY → EXPIRED`: Reaper (idle), Admin „Freigeben", Foto-Löschung (nur betroffene Parts).
`EXPIRED → QUEUED`: **ausschließlich** eine explizite Anforderung (`requestBuild`) — nie ein
Upload.

Die reine Entscheidungsfunktion lebt bewusst getrennt vom Effekt: `expiry.ts` enthält nur
`archiveExpiresAt` / `isExpired` und importiert **nichts** aus DB, S3 oder env (die TTL kommt als
Parameter herein) — genau damit ein reiner Unit-Test sie ohne Datenbank oder Uhr-Mocking gegen
ihre Kanten prüfen kann. Der Effekt (`expireArchive`, der Reaper-Loop, die Admin-Freigabe) lebt in
`reaper.ts`. `archiveExpiresAt` ist zugleich die einzige Quelle für die
Restlaufzeit-Anzeige im Admin-Panel (`payload.ts` → `getDownloadJobStatus`) — Reaper-Entscheidung
und Countdown-Anzeige können dadurch nie auseinanderlaufen.

# Monitoring

Sieben neue Prometheus-Metriken (`apps/api/src/lib/metrics.ts`), plus eine Grafana-Row „Archive
Lifecycle" (in **beiden** Dashboard-JSONs — `monitoring/grafana/dashboards/pixshar-overview.json`
für Compose und `helm/pixshar/dashboards/pixshar-overview.json` für die Helm-ConfigMap):

| Metrik | Typ | Labels | Beantwortet |
|---|---|---|---|
| `pixshar_archive_expiries` | Gauge (aus DB) | `event`, `quality` | Welches Event trifft der Reaper wie oft |
| `pixshar_archive_rebuilds` | Gauge (aus DB) | `event`, `quality` | Welches Event wird wie oft neu gebaut |
| `pixshar_archive_live_bytes` | Gauge | `quality` | Was das Archiv gerade auf S3 kostet |
| `pixshar_archive_bytes_reclaimed_total` | Counter | `quality` | Wie viel der Reaper freigeräumt hat |
| `pixshar_archive_expired_total` | Counter | `quality` | Reaper-/Freigabe-Treffer gesamt |
| `pixshar_archive_builds_total` | Counter | `quality`, `trigger` | Gewollte Arbeit vs. Thrash |
| `pixshar_archive_expiry_to_rebuild_seconds` | Histogram | `quality` | Ist die TTL zu kurz? |

`trigger` ∈ `first_build | on_demand_rebuild | append | admin` (gezählt in `triggers.ts`/`admin.ts`
an genau der Stelle, an der ein Build-*Zyklus* aus einem idle Zustand heraus geplant wird — eine
zweite Foto-Ankunft im selben Debounce-Fenster verlängert denselben Zyklus und zählt nicht erneut).
Das Histogram (Buckets 1 h / 6 h / 1 d / 3 d / 7 d / 14 d / 30 d) beantwortet die TTL-Frage direkt:
ein dickes linkes Ende heißt „der Reaper schneidet in aktive Nutzung, TTL erhöhen".

**Warum die beiden Per-Event-Gauges DB-gestützt sind, nicht In-Process-Counter:** Ablauf und
Rebuild sind pro Event seltene Ereignisse, deren Wert in der Historie über Wochen liegt.
In-Process-Zähler würden bei jedem Pod-Restart auf 0 zurückfallen und genau die Historie löschen,
gegen die `DOWNLOAD_ARCHIVE_TTL_DAYS` justiert wird. Die Zählstände leben daher in `DownloadJob`
(`expiryCount`/`rebuildCount`); der Exporter spiegelt sie beim Scrape — dasselbe Muster wie
`photosByStatus`: Aggregat-Query in `collect()`, `reset()` vor `set()` — beschränkt auf
`DownloadJob`s mit Aktivität in den letzten 30 Tagen, was die Label-Kardinalität deckelt (wächst
mit aktiven Events, nicht mit jedem je gehosteten Event). Das `event`-Label trägt den Slug für
lesbare Grafana-Panels.

# API-Oberfläche (neu/geändert)

- `POST /api/gallery/:slug/download/request?quality=` — Gast fordert einen Build an
  (`requestBuild`, ratelimitiert 20/min).
- `GET /api/gallery/:slug/download/part/:index?quality=` — Gast lädt einen Part; stempelt
  `lastDownloadedAt`, 302 auf frisch signierte S3-URL, 404 wenn der Part kein Objekt (mehr) hat.
- `POST /api/events/:id/download/release?quality=` — Admin reklamiert eine Variante sofort statt
  auf den Reaper zu warten; ruft dieselbe `expireArchive`-Funktion.
- `GET /api/gallery/:slug/download` löst keinen Build mehr aus (reiner Read); Part-URLs im Payload
  zeigen jetzt auf den Redirect-Endpoint, nicht mehr auf S3.
- Admin-Statusfelder (`GET /api/events/:id/download/status?quality=`) tragen zusätzlich
  `lastDownloadedAt`, `readyAt`, `expiredAt`, `expiresAt` (die Restlaufzeit-Anzeige).

Siehe [Gallery API](/api/gallery-api.md) und [Admin API](/api/admin-api.md) für die vollständige
Beschreibung.

# Konfiguration

`DOWNLOAD_ARCHIVE_TTL_DAYS` (Default 5, `0` = nie ablaufen) und `DOWNLOAD_ARCHIVE_SWEEP_SECONDS`
(Default 3600), durchgereicht via `.env.example`, `docker-compose.yml` (API **und** Worker brauchen
denselben Wert — die API löst/zeigt Expiry an, der Worker sweept) sowie `helm/pixshar/values.yaml`
+ `templates/configmap.yaml`. Das Helm-Template nutzt `dig` statt `default` für die TTL, weil
`default` den Wert `0` fälschlich als „nicht gesetzt" behandeln und auf 5 zurückfallen würde —
genau der Fall, den ein Selfhoster mit „nie ablaufen" nicht erwartet.

# Nicht in dieser Iteration

- **TTL pro Event oder pro Preisstufe** und ein „dauerhaft bereithalten"-Pin am Event. Erst eine
  globale TTL; die Metriken zeigen, ob feinere Steuerung überhaupt gebraucht wird.
- **S3-Lifecycle als Waisen-Backstop** — s.o., zwei Löschpfade zu viel für jetzt.
- **E-Mail-Benachrichtigung**, wenn ein angeforderter Build fertig ist.
- **Repacking/Defragmentieren** der Parts beim Rebuild — Membership-Erhaltung ist der Zweck.
- **Löschen der Original-/Display-Quellobjekte** (Basic/Premium-Tier) und jede Billing-Logik.

# Citations

[1] [Archive generation architecture](/architecture/archive-generation.md)
[2] [Download Jobs data model](/data-model/download-jobs.md)
[3] [Multi-part archive decision](/decisions/multi-part-archive.md)
[4] [Download-Varianten decision](/decisions/download-variants.md)
[5] [Presigned URLs](/decisions/presigned-urls.md)
[6] [Durable queue decision](/decisions/durable-queue.md)
