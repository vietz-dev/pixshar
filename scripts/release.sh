#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Release script — called by changesets/action after the Version PR is merged.
#
# The Version PR already bumped package.json + Helm chart. This script only
# creates git tags and pushes them — no branch push needed (already on main).
# ============================================

VERSION=$(node -p "require('./packages/shared/package.json').version")

# Skip if already released
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  echo "v${VERSION} already exists — nothing to do"
  exit 0
fi

echo "Releasing v${VERSION}"

# Create per-package tags (changesets convention: @pixshar/api@1.2.3 etc.)
bunx changeset tag

# Create unified release tag so the build pipeline triggers on v*
git tag "v${VERSION}"

# Push all tags pointing to this commit (unified v* + per-package @pixshar/*)
git push origin $(git tag --points-at HEAD)
echo "✔ Released v${VERSION}"
