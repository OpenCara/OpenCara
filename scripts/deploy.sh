#!/usr/bin/env bash
# Build, migrate, and restart the production opencara.com orchestrator on :3030.
#
# Order matters: migrations run BEFORE we kill the old process, so a failed
# migration leaves production untouched. The orchestrator itself also runs
# migrations on boot (packages/orchestrator/src/index.ts) — this script is
# the happy path; that's the safety net for any other restart mechanism.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG=/tmp/opencara-orchestrator.log
PORT=3030

echo "==> Installing dependencies (frozen lockfile)"
# --frozen-lockfile fails loudly if package.json drifted from pnpm-lock.yaml,
# which is what we want on a production deploy. Catches the case where a pull
# brought in new deps (e.g. PR #123 added remark-breaks / highlight.js) and
# the build would otherwise fail mid-way with a missing-module TS error.
pnpm install --frozen-lockfile

echo "==> Building all packages"
pnpm -r build

echo "==> Applying drizzle migrations"
# Source the orchestrator's .env so DATABASE_URL is in the environment for
# drizzle-kit. drizzle-kit bundles dotenv and auto-loads .env from cwd, but
# relying on that means a missing DATABASE_URL would silently fall through
# to drizzle.config.ts's localhost:5433 fallback and pretend-migrate the
# wrong DB. Explicit source closes that gap regardless of library behavior.
set -a
# shellcheck disable=SC1091
source "$ROOT/packages/orchestrator/.env"
set +a
pnpm --filter @opencara/orchestrator db:migrate

echo "==> Stopping current orchestrator on :$PORT (if any)"
PIDS=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
if [[ -n "$PIDS" ]]; then
  for pid in $PIDS; do
    echo "    kill -TERM $pid"
    kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 10); do
    sleep 0.5
    if ! ss -tln 2>/dev/null | grep -q ":$PORT "; then
      break
    fi
  done
  REMAINING=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
  if [[ -n "$REMAINING" ]]; then
    for pid in $REMAINING; do
      echo "    kill -KILL $pid (didn't exit on TERM)"
      kill -KILL "$pid" 2>/dev/null || true
    done
    sleep 0.5
  fi
fi

echo "==> Starting orchestrator (log: $LOG)"
cd "$ROOT/packages/orchestrator"
nohup node --import tsx --env-file=.env src/index.ts > "$LOG" 2>&1 &
disown

echo "==> Waiting for :$PORT/health"
for _ in $(seq 1 30); do
  sleep 0.5
  if curl -fsS -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then
    echo "==> Local health OK"
    break
  fi
done

if ! curl -fsS -o /dev/null "http://localhost:$PORT/health"; then
  echo "ERROR: orchestrator failed to come up; tailing $LOG:" >&2
  tail -50 "$LOG" >&2 || true
  exit 1
fi

if curl -fsS -o /dev/null https://opencara.com/health; then
  echo "==> opencara.com health OK"
else
  echo "WARN: opencara.com health check failed (tunnel may still be reconnecting)"
fi
