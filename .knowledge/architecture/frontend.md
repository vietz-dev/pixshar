---
type: Architecture
title: Frontend
description: Next.js 15 App Router application for both the guest gallery and admin studio.
tags: [frontend, nextjs, ui]
timestamp: 2026-07-03T00:00:00Z
---

# Technology

The frontend is a **Next.js 15** application using the App Router with `output: standalone` for Docker image builds. The standalone output bundles only the Node.js runtime files needed at run time, keeping images small.

# Client/Server Split

The application favors **React Server Components** for data fetching and page shells. `"use client"` is added only at the boundary where interactivity is required — forms, real-time SSE listeners, lightboxes, upload modals. This keeps the initial HTML meaningful without JavaScript.

# Styling

There is **no component library or CSS framework**. All styling is plain CSS using a set of CSS custom properties (variables) defined in `globals.css`:

| Variable | Role |
|---|---|
| `--bg` | Page background |
| `--surface` | Card / panel background |
| `--border` | Separator and border color |
| `--text` | Primary text |
| `--text-muted` | Secondary / hint text |
| `--accent` | Brand action color |
| `--danger` | Destructive action color |
| `--radius` | Default border radius |

Inline styles and these variables are used throughout components. This choice was deliberate: it removes build-time CSS tooling, makes theming trivial (swap variables in one file), and keeps components portable.

# Internationalisation

`next-intl` is used for i18n. Message files live alongside the app and cover both English and German. All user-visible strings must use translation keys; no hard-coded copy in components.

# Real-Time Updates

Photo processing progress and archive build status are delivered via **Server-Sent Events (SSE)**. The API exposes `/stream` endpoints; the frontend subscribes with `EventSource` and updates local state. No WebSockets are used — SSE is simpler to proxy and sufficient for one-directional push.

# Route Structure

| Route | Purpose | Auth |
|---|---|---|
| `/auth/login` | Admin login form | Public |
| `/admin` | Event list | Admin session |
| `/admin/events/new` | Create event form | Admin session |
| `/admin/events/[id]` | Event detail, upload, archive | Admin session |
| `/gallery/[slug]` | Password gate | Public |
| `/gallery/[slug]/view` | Photo grid, upload, download button | Gallery cookie |
| `/gallery/[slug]/download` | Multi-part archive download page | Gallery cookie |

# Citations

[1] [Next.js App Router docs](https://nextjs.org/docs/app)
[2] [next-intl](https://next-intl-docs.vercel.app/)
