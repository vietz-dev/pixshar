#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Release script — called by changesets/action when a Version PR is merged.
#
# Flow:
#   1. changeset version already bumped package.json versions (committed in the PR)
#   2. This script bumps the Helm chart to match
#   3. Creates git tags (per-package + unified v*) so the build pipeline triggers
#   4. Pushes everything
#
# Idempotent: safe to re-run if the workflow retriggers after this commit.
# ============================================

# Read the version — all fixed packages share the same version, so any works
VERSION=$(node -p "require('./packages/shared/package.json').version")

# Skip if already released
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  echo "v${VERSION} already exists — nothing to do"
  exit 0
fi

echo "Releasing v${VERSION}"

# ---- Bump Helm chart ----
sed -i "s/^version:.*/version: ${VERSION}/" helm/pixshar/Chart.yaml
sed -i "s/^appVersion:.*/appVersion: ${VERSION}/" helm/pixshar/Chart.yaml

git add helm/pixshar/Chart.yaml
# Only commit if the helm file actually changed
if git diff --cached --quiet; then
  echo "Helm chart already at v${VERSION}"
else
  git commit -m "chore: bump helm chart to v${VERSION}"
fi

# ---- Create tags ----

# Per-package tags (changesets convention, e.g. @pixshar/api@1.2.3)
bunx changeset tag

# Unified release tag so the release build workflow triggers on v*
git tag "v${VERSION}"

# ---- Push ----
git push origin main "v${VERSION}"

echo "✔ Released v${VERSION}"
