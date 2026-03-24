#!/usr/bin/env bash
# Wait for OpenCara bot review on a PR, with manual trigger fallback.
# Usage: scripts/wait-bot-review.sh <PR_NUMBER>
# Exit codes:
#   0 — bot review found
#   1 — no review after all attempts (proceed with self-review only)

set -euo pipefail

PR_NUMBER="${1:?Usage: scripts/wait-bot-review.sh <PR_NUMBER>}"
REPO="OpenCara/OpenCara"
BOT_LOGIN="opencara[bot]"
POLL_INTERVAL=30
POLL_TIMEOUT=1200  # 20 minutes
MANUAL_TRIGGER_WAIT=300  # 5 minutes
MAX_MANUAL_TRIGGERS=2

check_bot_review() {
  local pr_reviews comments total
  pr_reviews=$(gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" \
    --jq "[.[] | select(.user.login == \"$BOT_LOGIN\")] | length" 2>/dev/null || echo 0)
  comments=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" \
    --jq "[.[] | select(.user.login == \"$BOT_LOGIN\")] | length" 2>/dev/null || echo 0)
  total=$((pr_reviews + comments))
  if [ "$total" -gt 0 ]; then
    echo "Bot review found ($pr_reviews review(s), $comments comment(s))"
    return 0
  fi
  return 1
}

# Phase 1: Poll for bot review (up to POLL_TIMEOUT)
echo "Waiting for OpenCara bot review on PR #$PR_NUMBER (up to $((POLL_TIMEOUT / 60)) minutes)..."
elapsed=0
while [ "$elapsed" -lt "$POLL_TIMEOUT" ]; do
  if check_bot_review; then
    exit 0
  fi
  elapsed=$((elapsed + POLL_INTERVAL))
  echo "Waiting for bot review... ($elapsed/${POLL_TIMEOUT}s)"
  sleep "$POLL_INTERVAL"
done

# Phase 2: Manual triggers with /opencara review
for attempt in $(seq 1 "$MAX_MANUAL_TRIGGERS"); do
  echo "No bot review after polling. Manual trigger attempt $attempt/$MAX_MANUAL_TRIGGERS..."
  gh pr comment "$PR_NUMBER" --body "/opencara review"
  waited=0
  while [ "$waited" -lt "$MANUAL_TRIGGER_WAIT" ]; do
    sleep "$POLL_INTERVAL"
    waited=$((waited + POLL_INTERVAL))
    if check_bot_review; then
      exit 0
    fi
    echo "Waiting after manual trigger... ($waited/${MANUAL_TRIGGER_WAIT}s)"
  done
done

# Phase 3: No review after all attempts
echo "No bot review after $((POLL_TIMEOUT / 60))min polling + $MAX_MANUAL_TRIGGERS manual trigger(s). Proceeding with self-review only."
exit 1
