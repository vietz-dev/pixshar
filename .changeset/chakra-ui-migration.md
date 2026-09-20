---
"@pixshar/web": minor
---

Migrate the web app to Chakra UI v3 for components and layout.

All screens now render from Chakra components and semantic tokens defined in
`apps/web/src/components/theme.ts` — no inline style objects (outside PhotoGrid's
measured virtualizer boxes), no raw hex outside the theme. Overlays (lightbox,
upload modal, alert and bulk-rename dialogs) are `Dialog.Root`, so they are
portalled, focus-trapped and Escape-closable. Toasts moved from `sonner` to
Chakra's `toaster`; `sonner` is removed.
