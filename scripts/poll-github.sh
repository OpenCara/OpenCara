#!/usr/bin/env bash
# Poll GitHub for issues, PRs, and project board status.
# Consolidates polling commands used by PM into a single script.
# Uses REST API for issues/PRs (0 GraphQL points) and paginated
# GraphQL for board status (~2 points per 100 items vs ~203 for gh project item-list).
# Usage: scripts/poll-github.sh
# Output: JSON object with open_issues, closed_issues, open_prs, merged_prs, and board arrays
# Exit codes:
#   0 — success

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/project-board.sh"

# Issues and PRs via REST API (0 GraphQL points)
OPEN_ISSUES=$(gh api 'repos/OpenCara/OpenCara/issues?state=open&per_page=50' \
  --jq '[.[] | select(.pull_request == null) | {number, title, labels: [.labels[].name], createdAt: .created_at}]')
CLOSED_ISSUES=$(gh api 'repos/OpenCara/OpenCara/issues?state=closed&per_page=20&sort=updated&direction=desc' \
  --jq '[.[] | select(.pull_request == null) | {number, title, closedAt: .closed_at}]')
OPEN_PRS=$(gh api 'repos/OpenCara/OpenCara/pulls?state=open&per_page=20' \
  --jq '[.[] | {number, title, labels: [.labels[].name], createdAt: .created_at}]')
MERGED_PRS=$(gh api 'repos/OpenCara/OpenCara/pulls?state=closed&sort=updated&direction=desc&per_page=20' \
  --jq '[.[] | select(.merged_at != null) | {number, title, labels: [.labels[].name], mergedAt: .merged_at}]')

# Board status via paginated GraphQL (~2 pts per 100 items)
BOARD=$(fetch_board_items)

jq -n \
  --argjson open_issues "$OPEN_ISSUES" \
  --argjson closed_issues "$CLOSED_ISSUES" \
  --argjson open_prs "$OPEN_PRS" \
  --argjson merged_prs "$MERGED_PRS" \
  --argjson board "$BOARD" \
  '{open_issues: $open_issues, closed_issues: $closed_issues, open_prs: $open_prs, merged_prs: $merged_prs, board: $board}'
