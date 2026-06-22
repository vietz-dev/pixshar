#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Release script — called by changesets/action after the Version PR is merged.
#
# Creates a single v{version} git tag and pushes it. release.yml triggers
# on v* tags to build Docker images and package the Helm chart.
# ============================================

VERSION=$(node -p "require('./packages/shared/package.json').version")

# Skip if this version was already released
if git ls-remote --exit-code origin "refs/tags/v${VERSION}" >/dev/null 2>&1; then
  echo "v${VERSION} already exists on remote — nothing to do"
  exit 0
fi

echo "Releasing v${VERSION}"

# Create unified release tag
git tag "v${VERSION}"

# Push just this tag — triggers release.yml (on: push: tags: ['v*'])
echo "Pushing v${VERSION}…"

# Use RELEASE_TOKEN (PAT) so the push triggers other workflows.
# GITHUB_TOKEN pushes are intentionally ignored by GitHub Actions.
if [ -n "${RELEASE_TOKEN:-}" ]; then
  git remote set-url origin "https://x-access-token:${RELEASE_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
fi
git push origin "refs/tags/v${VERSION}"

echo "✔ Released v${VERSION}"
