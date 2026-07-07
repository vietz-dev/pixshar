---
type: Concept
title: Direktexport zu Google Fotos und Dropbox
description: Zukünftiges Konzept für server-seitigen Direkttransfer von Event-Fotos in die Cloud-Bibliothek des Gastes — als komfortablere Alternative zum ZIP-Download.
tags: [concept, future, google-photos, dropbox, oauth, export, saas, guest-ux]
status: future — nicht implementiert
timestamp: 2026-07-07T00:00:00Z
---

# Motivation

ZIP-Downloads überfordern viele nicht-technische Nutzer — insbesondere auf mobilen Geräten.
Bei Events mit 1 000+ Fotos und 10+ GB sind auch Einzel-Downloads keine Option.

Der eleganteste Weg für diese Nutzergruppe: **Pixshar überträgt die Fotos serverseitig direkt**
in die Cloud-Bibliothek des Gastes. Der Gast autorisiert einmalig per OAuth und muss nichts
herunterladen.

Pixieset bietet genau dieses Feature (Google Fotos + Dropbox) und nutzt es als
Differenzierungsmerkmal gegenüber reinem ZIP-Download. Zitat aus deren Blog:
> "If they choose Google Photos or Dropbox, images will be available to view/download
> in their account."
Fotos landen dabei in der allgemeinen Bibliothek, sortiert nach Aufnahmedatum — kein
dediziertes Album wird erzeugt (Google hat die Album-Erstellung via API 2019 eingeschränkt).

# Plattformen im Vergleich

## Google Fotos

**API**: Google Photos Library API (REST, OAuth 2.0)
- Fotos hochladen: `POST https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate` ✓
- Album erstellen: **eingeschränkt seit 2019** — neue Apps dürfen keine Alben mehr anlegen.
  Fotos landen in der Bibliothek des Nutzers ohne dedizierte Gruppierung.
- Authentifizierung: OAuth 2.0 Scope `https://www.googleapis.com/auth/photoslibrary.appendonly`
- Self-Hosting-Hürde: Betreiber müssen ein Google Cloud Project anlegen, die
  Photos Library API aktivieren und OAuth-Credentials (Client ID + Secret) erstellen.
  Das ist eine nicht-triviale Einrichtung für Self-Hosters.
- Token-Verwaltung: Access Tokens laufen nach 1 h ab; Refresh Tokens müssen verschlüsselt
  in der DB gespeichert werden (neues Sicherheitserfordernis).

**Referenzimplementierung**: Pixieset — setzt exakt diesen Flow produktiv ein.

## Dropbox

**API**: Dropbox API v2 (REST, OAuth 2.0)
- Fotos hochladen: `POST https://content.dropboxapi.com/2/files/upload` ✓
- Ordner erstellen: `POST https://api.dropboxapi.com/2/files/create_folder_v2` ✓ (keine Einschränkung)
- Authentifizierung: OAuth 2.0 Scope `files.content.write`
- **Vorteil gegenüber Google Fotos**: Ordner können frei angelegt werden →
  Fotos landen in `/Pixshar/Hochzeit Max & Julia/` statt irgendwo in der Bibliothek.
  Das ist für Nutzer deutlich nachvollziehbarer.
- Self-Hosting-Hürde: Dropbox App im Developer-Portal registrieren (einfacher als Google Cloud).
- Token-Verwaltung: ähnlich wie Google — Refresh Tokens nötig.

**Referenzimplementierung**: Pixieset — ebenfalls produktiv im Einsatz.

## Apple iCloud Fotos

**API**: **Nicht vorhanden.**
- Apple stellt keine öffentliche Server-API für iCloud Fotos bereit.
- Die Photos-Framework-API ist ausschließlich on-device (macOS/iOS), nicht server-seitig nutzbar.
- Keine REST-Schnittstelle, keine OAuth-Integration, keine Möglichkeit zum programmatischen
  Upload von einem externen Server.
- **Fazit**: Ein Direktexport zu Apple Fotos ist zum aktuellen Zeitpunkt technisch nicht
  realisierbar. Apple-Nutzer sind auf ZIP-Download oder manuelle Einzelspeicherung angewiesen.
  Das wird sich voraussichtlich nicht ändern, solange Apple keine öffentliche API bereitstellt.

# Vorgesehener Flow (Google Fotos & Dropbox)

```
Gast klickt "In Google Fotos exportieren"
  → OAuth-Redirect zu Google/Dropbox
  → Autorisierung durch den Gast
  → Callback: Pixshar speichert refresh_token (verschlüsselt) in der DB
  → Background-Job: iteriert alle PROCESSED Fotos des Events
      → streamt jeweils: S3 → Google Photos API / Dropbox API
  → Fortschritt in der UI (z. B. "847 / 1328 Fotos übertragen")
  → Abschluss: Benachrichtigung an den Gast
```

Kein lokaler Download auf dem Gerät des Gastes erforderlich.

# Nachsynchronisation

Wenn nach dem Export neue Fotos zum Event hinzukommen (z. B. Gäste laden nach):

1. Neue `Photo`-Rows erhalten einen `exportedAt`-Timestamp pro Export-Job (neue DB-Tabelle).
2. Ein erneuter Export-Aufruf erkennt nicht-exportierte Fotos und überträgt nur diese.
3. Bei Dropbox: neue Fotos werden in denselben Ordner abgelegt.
4. Bei Google Fotos: neue Fotos landen ebenfalls in der Bibliothek (kein Album → keine
   Zuordnung zum vorherigen Export sichtbar für den Nutzer, akzeptabler Trade-off).

# Datenbankänderungen (skizziert)

```
CloudExportJob
  id, eventId, guestToken (welcher Gast hat autorisiert),
  provider (GOOGLE_PHOTOS | DROPBOX),
  refreshToken (verschlüsselt), accessToken (kurzlebig, cached),
  status (PENDING | RUNNING | DONE | FAILED),
  exportedCount, failedCount, lastPhotoId,
  createdAt, updatedAt

Photo (Ergänzung)
  exportJobs: CloudExportJob[]   (Relation, um zu tracken was bereits exportiert wurde)
```

# Self-Hosting-Komplexität

Für Self-Hosters entsteht zusätzlicher Einrichtungsaufwand pro Plattform:

| Plattform | Erforderlich vom Betreiber |
|---|---|
| Google Fotos | Google Cloud Project, Photos Library API aktivieren, OAuth 2.0 Client ID/Secret |
| Dropbox | Dropbox Developer App registrieren, OAuth 2.0 Key/Secret |
| Apple | Nicht möglich |

Das Feature sollte daher **optional und klar dokumentiert** sein — aktivierbar über
Umgebungsvariablen (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DROPBOX_APP_KEY` etc.).
Fehlen diese, wird die jeweilige Export-Option in der UI nicht angezeigt.

# Empfohlene Reihenfolge der Umsetzung

1. **Dropbox zuerst** — einfachere API, keine Album-Einschränkung, Ordnerstruktur möglich,
   geringere Self-Hosting-Hürde.
2. **Google Fotos danach** — größere Nutzerbasis, aber mehr Komplexität (Album-Restriktion,
   Google Cloud Setup).
3. **Apple**: kein Handlungsbedarf bis Apple eine API bereitstellt.

# Verwandte Konzepte und Entscheidungen

- [ZIP TTL Storage](/concepts/zip-ttl-storage.md) — ZIP bleibt der primäre Download-Weg;
  Cloud-Export ist eine komplementäre Option, kein Ersatz.
- [KEDA Worker Scaling](/concepts/keda-worker-scaling.md) — Export-Jobs könnten denselben
  KEDA-skalierten Worker-Pool nutzen wie ZIP-Builds.
- [Durable Queue](/decisions/durable-queue.md) — Export-Jobs sollten als eigener Job-Typ
  in dieselbe pg-boss-Queue eingereiht werden (lange Laufzeit, Retry bei Netzwerkfehlern).

# Quellen und Referenzen

- Pixieset Direktexport (Produkt-Referenz): https://blog.pixieset.com/blog/download-to-dropbox-and-google-photos/
- Google Photos Library API: https://developers.google.com/photos/library/guides/upload-media
- Google Album-Einschränkung (2019): https://developers.google.com/photos/library/guides/create-albums
- Dropbox Upload API: https://www.dropbox.com/developers/documentation/http/documentation#files-upload
- Dropbox OAuth 2.0: https://www.dropbox.com/developers/reference/oauth-guide
