---
type: Architecture
title: Frontend
description: Next.js App Router application for both the guest gallery and admin studio, built on Chakra UI v3.
tags: [frontend, nextjs, chakra-ui, ui]
timestamp: 2026-09-20T00:00:00Z
---

# Technology

The frontend is a **Next.js 16** application using the App Router with `output: standalone` for Docker image builds. The standalone output bundles only the Node.js runtime files needed at run time, keeping images small.

# Client/Server Split

The application favors **React Server Components** for data fetching and page shells. `"use client"` is added only at the boundary where interactivity is required — forms, real-time SSE listeners, lightboxes, upload modals. This keeps the initial HTML meaningful without JavaScript.

# Styling

The UI is built on **Chakra UI v3** — components *and* layout. Emotion is the style runtime; a server-inserted cache registry flushes critical styles during SSR so the first paint is styled. Chakra's preflight provides the CSS reset. Chakra's official builder/migrate/refactor agent skills are vendored in the repo so agent-driven UI work stays on-pattern.

A single theme module is the only source of colors, radii, fonts, shadows and gradients. Call sites use **semantic token names**, never raw values:

| Token | Role |
|---|---|
| `bg` | Page background |
| `surface` | Card / panel background |
| `border` | Separator and border color |
| `fg` / `fgMuted` / `fgSubtle` | Text, in descending emphasis |
| `accent` | Brand action color (also a full `colorPalette`) |
| `danger` / `success` / `warning` | Status colors |
| `control` / `card` / `pill` | Named radii |

Rules that keep the system coherent:

- No inline style objects and no raw hex outside the theme. The one exception is the photo grid's virtualizer boxes, whose geometry is computed, not themed.
- Hover and focus are declarative (`_hover`, `_focusVisible`), never imperative DOM style mutation.
- Recipes exist only for primitives with a proven second call site; Chakra's defaults are preferred where they already resolve to the right token.
- The global stylesheet holds only the handful of live `@keyframes`; everything else is theme-level global CSS.
- Overlays are all one dialog primitive, so they are portalled, focus-trapped, scroll-locking and Escape-closable by construction.
- Toasts come from Chakra's toaster.

Dark mode is deliberately deferred. Because every call site names a semantic token, enabling it is a single pass over the theme rather than a sweep over components.

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
