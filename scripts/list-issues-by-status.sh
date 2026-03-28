#!/usr/bin/env bash
# List GitHub Project board issues filtered by status.
# Uses paginated GraphQL (~2 points per 100 items vs ~203 for gh project item-list).
# Usage: scripts/list-issues-by-status.sh <STATUS>
# STATUS: backlog | ready | in-progress | in-review | done
# Output: JSON array of {number, title} objects
# Exit codes:
#   0 — success (outputs JSON array, may be empty)
#   1 — invalid status

set -euo pipefail

STATUS="${1:?Usage: scripts/list-issues-by-status.sh <STATUS>}"

# Map CLI status names to project board display names
case "$STATUS" in
  backlog)      DISPLAY_STATUS="Backlog" ;;
  ready)        DISPLAY_STATUS="Ready" ;;
  in-progress)  DISPLAY_STATUS="In progress" ;;
  in-review)    DISPLAY_STATUS="In review" ;;
  done)         DISPLAY_STATUS="Done" ;;
  *)
    echo "Invalid status: $STATUS" >&2
    echo "Valid statuses: backlog, ready, in-progress, in-review, done" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/project-board.sh"

fetch_board_items | jq --arg status "$DISPLAY_STATUS" \
  '[.[] | select(.status == $status) | {number, title}]'
