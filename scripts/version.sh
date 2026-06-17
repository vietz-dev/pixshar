#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Version script — called by changesets/action when creating the Version PR.
#
# Runs changeset version (bumps package.json files), then bumps the Helm
# chart to match, so the Version PR contains everything in one commit.
# ============================================

# Bump all package.json versions (removes changeset files, updates CHANGELOG)
bunx changeset version

# Read the new version from any fixed package (all share the same version)
VERSION=$(node -p "require('./packages/shared/package.json').version")
echo "Bumping Helm chart to v${VERSION}"

# Bump Helm chart
sed -i "s/^version:.*/version: ${VERSION}/" helm/pixshar/Chart.yaml
sed -i "s/^appVersion:.*/appVersion: ${VERSION}/" helm/pixshar/Chart.yaml

# Stage everything so the Version PR commit includes all bumps
git add .
