#!/usr/bin/env bash
# Release script for OpenCara prod worker using CF Workers Versions & Deployments.
#
# Usage:
#   scripts/release.sh <version>          # Full release (upload → deploy → tag → publish)
#   scripts/release.sh <version> --test   # Upload + test instructions, pause before deploy
#   scripts/release.sh rollback           # Instant rollback to previous version
#
# Requires: wrangler CLI, pnpm, gh CLI, CLOUDFLARE_API_TOKEN (or wrangler auth)

set -euo pipefail

WORKER_NAME="opencara-server"
SERVER_DIR="packages/server"
CLI_DIR="packages/cli"
PROD_URL="https://opencara-server.opencara.workers.dev"

# ── Helpers ──────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

info() { echo "==> $*"; }

confirm() {
  read -r -p "$1 [y/N] " response
  [[ "$response" =~ ^[Yy]$ ]]
}

# ── Rollback ─────────────────────────────────────────────────────

if [[ "${1:-}" == "rollback" ]]; then
  info "Rolling back ${WORKER_NAME} to previous version..."
  (cd "$SERVER_DIR" && npx wrangler rollback)
  info "Rollback complete. Verify at: ${PROD_URL}/api/meta"
  exit 0
fi

# ── Parse arguments ──────────────────────────────────────────────

VERSION="${1:?Usage: scripts/release.sh <version> [--test] | scripts/release.sh rollback}"
TEST_MODE=false
if [[ "${2:-}" == "--test" ]]; then
  TEST_MODE=true
fi

# Validate semver format
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "Version must be semver (e.g., 0.16.0), got: ${VERSION}"
fi

# ── Pre-flight checks ───────────────────────────────────────────

info "Pre-flight checks..."

# Clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  die "Working tree is not clean. Commit or stash changes first."
fi

# On main branch
BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "main" ]]; then
  die "Must be on main branch (currently on: ${BRANCH})"
fi

# Build and test
info "Building and testing..."
pnpm build
pnpm test

info "Pre-flight checks passed."

# ── Inject infrastructure IDs ────────────────────────────────────

info "Injecting infrastructure IDs..."

if [[ -z "${CF_PROD_D1_ID:-}" ]]; then
  die "CF_PROD_D1_ID environment variable is required"
fi

sed -i "s/REPLACE_WITH_PROD_D1_DATABASE_ID/${CF_PROD_D1_ID}/" "${SERVER_DIR}/wrangler.toml"

info "Infrastructure IDs injected."

# ── D1 migrations ────────────────────────────────────────────────

info "Running D1 migrations..."
(cd "$SERVER_DIR" && npx wrangler d1 migrations apply opencara-db --remote)

# ── Upload new version ───────────────────────────────────────────

info "Uploading new version..."
UPLOAD_OUTPUT="$(cd "$SERVER_DIR" && npx wrangler versions upload 2>&1)"
echo "$UPLOAD_OUTPUT"

# Extract version ID from wrangler output
VERSION_ID="$(echo "$UPLOAD_OUTPUT" | grep -oP 'Version ID:\s*\K[a-f0-9-]+' || true)"
if [[ -z "$VERSION_ID" ]]; then
  # Try alternative output format
  VERSION_ID="$(echo "$UPLOAD_OUTPUT" | grep -oP '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | tail -1 || true)"
fi

if [[ -z "$VERSION_ID" ]]; then
  die "Failed to extract version ID from wrangler output. Check output above."
fi

info "Uploaded version: ${VERSION_ID}"

# ── Restore wrangler.toml (undo sed) ────────────────────────────

git checkout -- "${SERVER_DIR}/wrangler.toml"

# ── Pre-deploy test ──────────────────────────────────────────────

if [[ "$TEST_MODE" == true ]]; then
  echo ""
  info "Pre-deploy test mode. Version uploaded but NOT deployed."
  echo ""
  echo "Test the new version against prod without deploying:"
  echo ""
  echo "  curl -H 'Cloudflare-Workers-Version-Overrides: ${WORKER_NAME}=${VERSION_ID}' \\"
  echo "       ${PROD_URL}/api/meta"
  echo ""
  echo "Run a health check:"
  echo ""
  echo "  curl -sf -H 'Cloudflare-Workers-Version-Overrides: ${WORKER_NAME}=${VERSION_ID}' \\"
  echo "       ${PROD_URL}/api/meta | jq ."
  echo ""

  if ! confirm "Deploy version ${VERSION_ID} to 100% traffic?"; then
    info "Aborted. Version ${VERSION_ID} is uploaded but not deployed."
    info "To deploy later: cd ${SERVER_DIR} && npx wrangler versions deploy ${VERSION_ID}@100%"
    exit 0
  fi
fi

# ── Deploy ───────────────────────────────────────────────────────

info "Deploying version ${VERSION_ID} to 100% traffic..."
(cd "$SERVER_DIR" && npx wrangler versions deploy "${VERSION_ID}@100%")

# Verify deployment
info "Verifying deployment..."
META_RESPONSE="$(curl -sf "${PROD_URL}/api/meta" 2>/dev/null || true)"
if [[ -n "$META_RESPONSE" ]]; then
  echo "  /api/meta response: ${META_RESPONSE}"
else
  echo "  WARNING: Could not reach ${PROD_URL}/api/meta — verify manually."
fi

# ── CLI publish (git tag) ────────────────────────────────────────

info "Setting CLI version to ${VERSION}..."
(cd "$CLI_DIR" && npm version "${VERSION}" --no-git-tag-version --allow-same-version)

# Commit version bump if there are changes
if [[ -n "$(git status --porcelain)" ]]; then
  git add "${CLI_DIR}/package.json"
  git commit -m "chore: bump CLI version to ${VERSION}"
fi

info "Creating git tag v${VERSION}..."
git tag "v${VERSION}"

info "Pushing tag v${VERSION} (triggers publish-cli.yml for npm publish)..."
git push origin main
git push origin "v${VERSION}"

# ── Done ─────────────────────────────────────────────────────────

echo ""
info "Release v${VERSION} complete!"
echo ""
echo "  Worker version: ${VERSION_ID}"
echo "  Git tag:        v${VERSION}"
echo "  Prod URL:       ${PROD_URL}/api/meta"
echo ""
echo "  To rollback:    scripts/release.sh rollback"
echo ""
