#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Release script — called by changesets/action after the Version PR is merged.
#
# 1. Bump Helm chart
# 2. Create git tag v{version}
# 3. Push tag
# 4. Dispatch release.yml workflow via GitHub API
# ============================================

set -x  # Debug: print every command

VERSION=$(node -p "require('./packages/shared/package.json').version")
echo "==> Releasing v${VERSION}"

# 1. Bump Helm chart (in case version.sh didn't run or failed)
echo "==> Bumping Helm chart..."
sed -i "s/^version:.*/version: ${VERSION}/" helm/pixshar/Chart.yaml
sed -i "s/^appVersion:.*/appVersion: ${VERSION}/" helm/pixshar/Chart.yaml
git add helm/pixshar/Chart.yaml
git diff --cached --quiet && echo "No Helm changes needed" || git commit -m "chore: bump helm chart to v${VERSION}"

# 2. Create unified release tag
echo "==> Creating tag v${VERSION}..."
git tag "v${VERSION}"

# 3. Push — use RELEASE_TOKEN if available, otherwise GITHUB_TOKEN
echo "==> Pushing tag..."
if [ -n "${RELEASE_TOKEN:-}" ]; then
  echo "Using RELEASE_TOKEN..."
  GIT_URL="https://x-access-token:${RELEASE_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
else
  echo "WARNING: RELEASE_TOKEN not set! Using GITHUB_TOKEN (may not trigger workflows)..."
  GIT_URL=$(git remote get-url origin)
fi
git remote set-url origin "$GIT_URL"
git push origin "refs/tags/v${VERSION}"

# 4. Dispatch release.yml workflow directly
echo "==> Dispatching release.yml..."
DISPATCH_RESPONSE=$(curl -s -X POST \
  -H "Authorization: token ${RELEASE_TOKEN:-${GITHUB_TOKEN}}" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/release.yml/dispatches" \
  -d "{\"ref\":\"refs/tags/v${VERSION}\",\"inputs\":{\"version\":\"${VERSION}\"}}")

if [ $? -eq 0 ]; then
  echo "✔ Successfully dispatched release.yml for v${VERSION}"
else
  echo "✗ Failed to dispatch release.yml"
  echo "Response: $DISPATCH_RESPONSE"
  exit 1
fi

set +x
echo "✔ Released v${VERSION}"
