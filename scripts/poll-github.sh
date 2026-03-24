#!/usr/bin/env bash
# Poll GitHub for issues, PRs, and project board status.
# Consolidates the 4 polling commands used by PM into a single script.
# Usage: scripts/poll-github.sh
# Output: JSON object with open_issues, closed_issues, open_prs, merged_prs, and board arrays
# Exit codes:
#   0 — success

set -euo pipefail

OPEN_ISSUES=$(gh issue list --state open --json number,title,labels,createdAt --limit 50)
CLOSED_ISSUES=$(gh issue list --state closed --json number,title,closedAt --limit 20)
OPEN_PRS=$(gh pr list --state open --json number,title,labels,createdAt --limit 20)
MERGED_PRS=$(gh pr list --state merged --json number,title,labels,mergedAt --limit 20)
BOARD=$(gh project item-list 1 --owner OpenCara --format json \
  | jq '[.items[] | {number: .content.number, title: .content.title, status: .status}]')

jq -n \
  --argjson open_issues "$OPEN_ISSUES" \
  --argjson closed_issues "$CLOSED_ISSUES" \
  --argjson open_prs "$OPEN_PRS" \
  --argjson merged_prs "$MERGED_PRS" \
  --argjson board "$BOARD" \
  '{open_issues: $open_issues, closed_issues: $closed_issues, open_prs: $open_prs, merged_prs: $merged_prs, board: $board}'
