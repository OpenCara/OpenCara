#!/usr/bin/env bash
# Set a GitHub Project board status for an issue.
# Usage: scripts/set-issue-status.sh <ISSUE_NUMBER> <STATUS>
# STATUS: backlog | ready | in-progress | in-review | done
# Exit codes:
#   0 — status updated
#   1 — issue not found in project or invalid status

set -euo pipefail

ISSUE_NUMBER="${1:?Usage: scripts/set-issue-status.sh <ISSUE_NUMBER> <STATUS>}"
STATUS="${2:?Usage: scripts/set-issue-status.sh <ISSUE_NUMBER> <STATUS>}"

PROJECT_ID="PVT_kwDOEAYvm84BSjju"
FIELD_ID="PVTSSF_lADOEAYvm84BSjjuzhADgLE"

# Map status name to option ID
case "$STATUS" in
  backlog)      OPTION_ID="f75ad846" ;;
  ready)        OPTION_ID="61e4505c" ;;
  in-progress)  OPTION_ID="47fc9ee4" ;;
  in-review)    OPTION_ID="df73e18b" ;;
  done)         OPTION_ID="98236657" ;;
  *)
    echo "Invalid status: $STATUS"
    echo "Valid statuses: backlog, ready, in-progress, in-review, done"
    exit 1
    ;;
esac

# Find the item ID for this issue in the project
ITEM_ID=$(gh project item-list 1 --owner OpenCara --format json \
  | jq -r ".items[] | select(.content.number == $ISSUE_NUMBER) | .id")

if [ -z "$ITEM_ID" ]; then
  echo "Issue #$ISSUE_NUMBER not found in project. Adding it first..."
  gh project item-add 1 --owner OpenCara --url "https://github.com/OpenCara/OpenCara/issues/$ISSUE_NUMBER"
  ITEM_ID=$(gh project item-list 1 --owner OpenCara --format json \
    | jq -r ".items[] | select(.content.number == $ISSUE_NUMBER) | .id")
  if [ -z "$ITEM_ID" ]; then
    echo "Failed to add issue #$ISSUE_NUMBER to project."
    exit 1
  fi
fi

gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
  --field-id "$FIELD_ID" --single-select-option-id "$OPTION_ID"

echo "Issue #$ISSUE_NUMBER → $STATUS"
