#!/usr/bin/env bash
# Pull and roll out a released OpenCara server image on the deploy host.
#
# Runs ON THE SERVER (the deploy workflow scp's this file + the prod compose
# into $DEPLOY_DIR and invokes it over SSH). It is deliberately the SAME entry
# point for a normal release and for a rollback — the only difference is the
# image tag you point it at:
#
#   First release / CI:   OPENCARA_IMAGE_TAG=v1.0.2 ./deploy.sh
#   Rollback (no CI):     OPENCARA_IMAGE_TAG=v1.0.1 ./deploy.sh
#
# Fails loudly (non-zero) if login, pull, start, or the health gate fails, so a
# broken release never reports green.

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/opencara}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3030/health}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-120}"

cd "$DEPLOY_DIR"

if [[ -z "${OPENCARA_IMAGE_TAG:-}" ]]; then
  echo "::error::OPENCARA_IMAGE_TAG is required (e.g. v1.0.2)." >&2
  exit 2
fi
export OPENCARA_IMAGE_TAG

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: $DEPLOY_DIR/$COMPOSE_FILE not found." >&2
  exit 2
fi
if [[ ! -f .env.production ]]; then
  echo "ERROR: $DEPLOY_DIR/.env.production not found (server secrets/config)." >&2
  exit 2
fi

echo "==> Deploying tag ${OPENCARA_IMAGE_TAG}"

# Registry login is optional: skip it for a public GHCR package, do it when a
# pull credential is provided (private package). Credentials are passed in by
# the workflow via env and never persisted to the repo.
if [[ -n "${GHCR_TOKEN:-}" ]]; then
  echo "==> Logging in to ${OPENCARA_REGISTRY:-ghcr.io}"
  echo "${GHCR_TOKEN}" | docker login "${OPENCARA_REGISTRY:-ghcr.io}" \
    -u "${GHCR_USERNAME:-opencara}" --password-stdin
fi

echo "==> Pulling image"
docker compose -f "$COMPOSE_FILE" pull server

# --wait blocks until the container is healthy (per its healthcheck) and exits
# non-zero if it never gets there or crashes — this is the primary deploy gate.
echo "==> Starting (waiting up to ${WAIT_TIMEOUT}s for healthy)"
if ! docker compose -f "$COMPOSE_FILE" up -d --wait --wait-timeout "$WAIT_TIMEOUT" server; then
  echo "ERROR: container did not become healthy; recent logs:" >&2
  docker compose -f "$COMPOSE_FILE" logs --tail=80 server >&2 || true
  exit 1
fi

# Belt-and-suspenders: confirm the endpoint actually answers from outside the
# container too (catches a healthcheck that passes but a port that isn't bound).
echo "==> Verifying ${HEALTH_URL}"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "$HEALTH_URL"; then
    echo "==> Health OK — ${OPENCARA_IMAGE_TAG} is live"
    # Reclaim disk from superseded image layers; keeps prior tags addressable
    # for rollback (only dangling layers are removed, not named images).
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 1
done

echo "ERROR: ${HEALTH_URL} never became reachable; recent logs:" >&2
docker compose -f "$COMPOSE_FILE" logs --tail=80 server >&2 || true
exit 1
