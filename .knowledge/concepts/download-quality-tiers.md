---
type: Concept
title: Download-Qualitätsstufen — komprimiert immer, Original nur auf Anfrage
description: Konzept für ein Event-Flag das steuert ob Original-Fotos heruntergeladen werden können. Komprimierte Variante ist immer verfügbar; Originalqualität ist optional und im SaaS-Kontext ggf. kostenpflichtig.
tags: [concept, future, download, quality, tiers, saas, archive, presigned-url, event-config]
status: future — nicht implementiert
timestamp: 2026-07-07T00:00:00Z
---

# Konzept

Standardmäßig stehen Gästen und Administratoren nur **komprimierte Fotos** (Display-Variante,
1920 px) zum Download bereit. Originalfotos in voller Auflösung sind ein optionales Feature,
das pro Event explizit freigeschaltet werden muss.

Diese Trennung gilt für **beide Download-Wege** gleichermaßen:
- **Archiv-Download** (ZIP): komprimiertes ZIP immer verfügbar; Original-ZIP nur wenn Flag gesetzt
- **Einzelbild-Download** (presigned URL): Display-URL immer; Original-URL nur wenn Flag gesetzt

Das Flag ist kein Benutzerrecht, sondern eine **Event-Konfiguration** — der Admin entscheidet
beim Erstellen oder Bearbeiten des Events, welche Qualitätsstufe angeboten wird.

# Regel: komprimiert ⊆ original

> Ist Original-Download aktiv, ist der komprimierte Download immer zusätzlich verfügbar.
> Ist Original-Download inaktiv, ist ausschließlich der komprimierte Download verfügbar.

Es gibt keine Kombination in der nur Originale aber keine komprimierte Variante angeboten wird.

# Datenmodell-Änderung

```prisma
model Event {
  // ... bestehende Felder ...
  allowOriginalDownload Boolean @default(false)
}
```

Kein weiteres Flag nötig — die komprimierte Variante ist implizit immer aktiv.

# Auswirkungen auf bestehende Systeme

## Presigned URLs (Einzelbild)

`GET /api/gallery/:slug` gibt heute Display- und Thumb-URLs zurück. Mit diesem Konzept:

```ts
// Bisher: immer beide Keys
{ displayUrl, thumbUrl }

// Künftig: originalUrl nur wenn Flag gesetzt
{ thumbUrl, displayUrl, originalUrl?: string }
```

Das Frontend zeigt den "Original herunterladen"-Button nur wenn `originalUrl` vorhanden ist.

## Archiv-Build (ZIP)

Der Archive-Builder erzeugt heute immer ein ZIP der PROCESSED Fotos — derzeit aus den
Original-Keys (zu prüfen, ob schon Display-Keys genutzt werden).

Mit diesem Konzept werden **zwei ZIP-Typen** unterschieden:

| ZIP-Typ | Inhalt | Immer gebaut | S3-Pfad |
|---|---|---|---|
| Komprimiert | Display-Variante (1920 px) | Ja | `{eventId}/archive/display-part-{n}.zip` |
| Original | Original-Upload | Nein — nur wenn Flag | `{eventId}/archive/original-part-{n}.zip` |

Die bestehende `DownloadArchivePart`-Tabelle braucht ein `quality`-Feld:

```prisma
enum ArchiveQuality {
  DISPLAY
  ORIGINAL
}

model DownloadArchivePart {
  // ... bestehende Felder ...
  quality ArchiveQuality @default(DISPLAY)
}
```

Der Build-Trigger erzeugt immer den Display-ZIP und zusätzlich den Original-ZIP wenn
`allowOriginalDownload = true`.

## Admin-UI (Event erstellen / bearbeiten)

Neue Checkbox/Toggle im Event-Formular:
> ☐ Original-Fotos zum Download anbieten

Im SaaS-Kontext: Toggle ist gesperrt solange das Paket keinen Original-Download einschließt,
mit Hinweis auf Upgrade-Möglichkeit.

## API-Routen

`GET /api/gallery/:slug` — prüft `event.allowOriginalDownload` und befüllt `originalUrl`
entsprechend (oder lässt das Feld weg).

`GET /api/upload/events/:id/photos/status` (Admin-Polling) — analog.

`GET /api/events/:id` (Admin-Detail) — gibt das Flag mit zurück damit die Admin-UI es
anzeigen kann.

# SaaS-Preisgestaltung

Original-Download ist ein Aufpreis-Feature weil es den Storage-Bedarf erheblich erhöht
(Originale müssen dauerhaft vorgehalten werden; komprimierte Variante allein würde nur
Display + Thumbs benötigen — ca. 0.5× des Uploads).

Mögliche Modelle:
- **Einmaliger Aufpreis pro Event**: "Original-Download freischalten für dieses Event: +X €"
- **Tier-gebunden**: Basic = nur komprimiert; Premium = Original inklusive
- **Kombinierbar**: Basis-Tier + buchbares Add-on "Original-Qualität"

Die Implementierung des Flags ist preismodell-unabhängig — die Steuerung welcher Plan das
Flag setzen darf, gehört in die Billing-Logik (noch nicht konzipiert).

# Interaktion mit anderen Konzepten

## ZIP TTL Storage

Wenn Original-Download deaktiviert ist, müssen Originale nach dem Resize-Processing
**nicht dauerhaft in S3 vorgehalten** werden (nur Display + Thumbs reichen). Das ist der
Haupthebel aus dem [ZIP TTL Konzept](/concepts/zip-ttl-storage.md):

| Event-Konfiguration | Originale in S3 | Display in S3 | Faktor |
|---|---|---|---|
| `allowOriginalDownload = false` | Gelöscht nach Processing | Dauerhaft | ~0.5× |
| `allowOriginalDownload = true` | Dauerhaft | Dauerhaft | ~1.5× |

Das Löschen der Originale darf erst erfolgen nachdem der Display-ZIP erfolgreich gebaut
und committed ist — andernfalls gibt es keine Möglichkeit mehr, einen Original-ZIP
nachträglich zu generieren.

## KEDA Worker Scaling

Der ZIP-Builder bekommt im Kontext des [KEDA-Konzepts](/concepts/keda-worker-scaling.md)
zwei separate Job-Typen in der Queue:
```
ZIP_BUILD_DISPLAY   — immer enqueued nach Photo-Processing
ZIP_BUILD_ORIGINAL  — nur enqueued wenn allowOriginalDownload = true
```

## Cloud-Export (Google Fotos / Dropbox)

Der [Cloud-Export](/concepts/cloud-export-google-dropbox.md) folgt derselben Logik:
Default-Export überträgt Display-Varianten; Original-Transfer nur wenn Flag gesetzt.

# Was heute bereits passt

- Display-Varianten (`{eventId}/display/`) werden bereits erzeugt und in S3 gespeichert.
- Presigned URLs werden bereits pro Variante generiert.
- Die Archive-Architektur ist bereits auf mehrere Part-Typen auslegbar (das `quality`-Feld
  ist eine additive Migration).

# Offene Fragen vor Implementierung

- [ ] Erzeugt der aktuelle Archive-Builder ZIPs aus `display/`- oder `originals/`-Keys?
      → Bestimmt ob der heutige ZIP de-facto schon "komprimiert" ist oder nicht.
- [ ] Sollen bereits hochgeladene Events (vor Einführung des Flags) `allowOriginalDownload = true`
      bekommen (Rückwärtskompatibilität) oder `false` (sparsamste Default-Annahme)?
      Empfehlung: `true` für Bestandsdaten (kein Verhalten bricht), `false` als Default
      für neue Events.
- [ ] Darf der Admin das Flag nachträglich **deaktivieren**? Dann müssten Original-ZIPs und
      ggf. Originaldateien aus S3 gelöscht werden — ein destruktiver Vorgang, der eine
      explizite Bestätigung braucht.
