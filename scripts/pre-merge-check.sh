#!/usr/bin/env bash
# Pre-merge verification: merge latest main, run all checks, post coverage to PR.
# Usage: scripts/pre-merge-check.sh <PR_NUMBER>
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -euo pipefail

PR_NUMBER="${1:?Usage: scripts/pre-merge-check.sh <PR_NUMBER>}"

echo "=== Pre-merge verification for PR #$PR_NUMBER ==="

echo "--- Fetching and merging latest main ---"
git fetch origin main
git merge origin/main --no-edit

echo "--- Build ---"
pnpm build

echo "--- Test ---"
pnpm test

echo "--- Lint ---"
pnpm lint

echo "--- Format check ---"
pnpm run format:check

echo "--- Typecheck ---"
pnpm run typecheck

echo "--- Coverage report ---"
COVERAGE_FILE=$(mktemp)
pnpm vitest run --coverage 2>&1 | tail -40 > "$COVERAGE_FILE"
gh pr comment "$PR_NUMBER" --body "$(printf '## Coverage Report\n\n```\n'; cat "$COVERAGE_FILE"; printf '```\n')"
rm -f "$COVERAGE_FILE"

echo "=== All pre-merge checks passed for PR #$PR_NUMBER ==="
