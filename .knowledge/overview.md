---
type: Product Overview
title: Pixshar
description: A self-hostable, private event photo sharing application for photographers.
tags: [product, overview]
timestamp: 2026-07-03T00:00:00Z
---

# What Pixshar Is

Pixshar is a self-hostable web application that lets a photographer (the admin) create password-protected photo galleries for events and share them with guests. It is designed for privacy: no photos are ever public, no guest accounts are created, and the entire stack can run on infrastructure the photographer controls.

# Core User Flows

**Photographer (admin):**
1. Creates a named gallery with a password and optional description.
2. Uploads photos via a drag-and-drop interface; uploads go directly to S3 (never through the server).
3. Photos are automatically resized to a display size (1920 px) and thumbnail (400 px) in the background.
4. Shares the gallery URL and password with guests.
5. A downloadable archive of all gallery photos is automatically built once processing is complete.

**Guest:**
1. Opens the gallery URL and enters the password.
2. Browses the photo grid; clicks a photo to open a full-screen lightbox.
3. Uploads their own photos (which are also processed and appear in the gallery).
4. Downloads the archive — split into parts if the gallery is large enough that a single download would be impractical.

# What Pixshar Is Not

- It is not a social photo platform. There is no public discovery, no profiles, and no feeds.
- It is not a multi-photographer studio tool. There is exactly one admin account per installation.
- It is not a cloud service. Pixshar is designed to be deployed on the photographer's own server or Kubernetes cluster.

# Design Principles

- **Privacy first.** Every piece of content is behind a password; presigned S3 URLs are the only public-facing artifact, and they expire.
- **Self-hosting first.** The application ships with Helm charts and Docker Compose, with bundled Postgres (CNPG) and Minio for installs that have no external dependencies.
- **Minimal friction for guests.** Guests need no account. A cookie scoped to a single event is all the session state they carry.
- **Durable processing.** Photo resizing and archive generation happen in a background worker process. The API remains available while heavy work runs.
