# @pixshar/web

## 0.1.0

### Minor Changes

- 3887e09: Migrate the web app to Chakra UI v3 for components and layout.

  All screens now render from Chakra components and semantic tokens defined in
  `apps/web/src/components/theme.ts` — no inline style objects (outside PhotoGrid's
  measured virtualizer boxes), no raw hex outside the theme. Overlays (lightbox,
  upload modal, alert and bulk-rename dialogs) are `Dialog.Root`, so they are
  portalled, focus-trapped and Escape-closable. Toasts moved from `sonner` to
  Chakra's `toaster`; `sonner` is removed.

### Patch Changes

- @pixshar/shared@0.1.0

## 0.0.31

### Patch Changes

- 94b7ef7: Compressed version of images
- Updated dependencies [94b7ef7]
  - @pixshar/shared@0.0.31

## 0.0.30

### Patch Changes

- f789fae: Stable Archieve Parts
- Updated dependencies [f789fae]
  - @pixshar/shared@0.0.30

## 0.0.29

### Patch Changes

- 9fda7f5: fix use memo errorwq
- Updated dependencies [9fda7f5]
  - @pixshar/shared@0.0.29

## 0.0.28

### Patch Changes

- e7ed55a: Admin Bulk edit, gallery filter
- Updated dependencies [e7ed55a]
  - @pixshar/shared@0.0.28

## 0.0.27

### Patch Changes

- 1715bbc: Virtual Scroll and Gallery Password updates
- Updated dependencies [1715bbc]
  - @pixshar/shared@0.0.27

## 0.0.26

### Patch Changes

- 2620ac6: i18n and better archive building
- Updated dependencies [2620ac6]
  - @pixshar/shared@0.0.26

## 0.0.25

### Patch Changes

- de78a3c: Fix linting errors
- Updated dependencies [de78a3c]
  - @pixshar/shared@0.0.25

## 0.0.24

### Patch Changes

- c378559: Added image processor
- Updated dependencies [c378559]
  - @pixshar/shared@0.0.24

## 0.0.23

### Patch Changes

- c8aa82b: Sequential processing of images
- Updated dependencies [c8aa82b]
  - @pixshar/shared@0.0.23

## 0.0.22

### Patch Changes

- 2a2322d: use forcePathStyle false because of tigris redirects
- Updated dependencies [2a2322d]
  - @pixshar/shared@0.0.22

## 0.0.21

### Patch Changes

- bdeff78: Better handling of building archieve for downlaod
- 81f8dfb: Detect Duplicate Upload
- Updated dependencies [bdeff78]
- Updated dependencies [81f8dfb]
  - @pixshar/shared@0.0.21

## 0.0.20

### Patch Changes

- 5b20d1e: test: release pipeline
- Updated dependencies [5b20d1e]
  - @pixshar/shared@0.0.20

## 0.0.19

### Patch Changes

- [`e9dca64`](https://github.com/vietz-dev/pixshar/commit/e9dca6449ae3686ea7f888b6f10cc637e677e63f) - fix release workflow

- Updated dependencies [[`e9dca64`](https://github.com/vietz-dev/pixshar/commit/e9dca6449ae3686ea7f888b6f10cc637e677e63f)]:
  - @pixshar/shared@0.0.19

## 0.0.18

### Patch Changes

- [`7897faf`](https://github.com/vietz-dev/pixshar/commit/7897faf0e07379ee59c2009aea683242b6d91665) - Use PAT for releases

- Updated dependencies [[`7897faf`](https://github.com/vietz-dev/pixshar/commit/7897faf0e07379ee59c2009aea683242b6d91665)]:
  - @pixshar/shared@0.0.18

## 0.0.17

### Patch Changes

- [`2c83c4f`](https://github.com/vietz-dev/pixshar/commit/2c83c4f8d412b83eaf174337409e270180266f40) - try fix release pipeline

- Updated dependencies [[`2c83c4f`](https://github.com/vietz-dev/pixshar/commit/2c83c4f8d412b83eaf174337409e270180266f40)]:
  - @pixshar/shared@0.0.17

## 0.0.16

### Patch Changes

- [`38547ba`](https://github.com/vietz-dev/pixshar/commit/38547badbd3b54decc2c7130d0d76e8baea87ca8) - create flow to build artifacts on new tag format

- Updated dependencies [[`38547ba`](https://github.com/vietz-dev/pixshar/commit/38547badbd3b54decc2c7130d0d76e8baea87ca8)]:
  - @pixshar/shared@0.0.16

## 0.0.15

### Patch Changes

- [`a0224ba`](https://github.com/vietz-dev/pixshar/commit/a0224ba05192c30c2a8cfc05c14f94412d6834bc) - Added changeset for bumping

- Updated dependencies []:
  - @pixshar/shared@0.0.15
