#!/usr/bin/env bash
# Process new webhook events and output PM-actionable notifications.
# Called by the PM polling cycle to react to real-time GitHub events.
#
# Usage:
#   scripts/process-webhook-events.sh
#
# Reads unprocessed events from .claude/github-events.jsonl (cursor-tracked),
# applies filter rules, and prints structured notifications to stdout.
# Returns exit code 0 if there are notifications, 1 if none.
#
# Filter rules (PM-actionable only):
#   1. Issue created → "TRIAGE|New issue #N: <title>"
#   2. Board status → Ready → "DISPATCH|Issue moved to Ready"
#   3. Human comment → "HUMAN_COMMENT|Comment on #N by <user>: <preview>"
#   4. Human review → "HUMAN_REVIEW|Review on #N by <user>: <preview>"
#   5. CI failed on main → "CI_FAILED|Workflow <name> failed on main"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVENTS_FILE="$REPO_ROOT/.claude/github-events.jsonl"
CURSOR_FILE="$REPO_ROOT/.claude/github-events.process-cursor"

if [ ! -f "$EVENTS_FILE" ]; then
    exit 1
fi

# Read cursor
CURSOR=0
if [ -f "$CURSOR_FILE" ]; then
    CURSOR=$(cat "$CURSOR_FILE")
fi

TOTAL=$(wc -l < "$EVENTS_FILE")

if [ "$CURSOR" -ge "$TOTAL" ]; then
    exit 1
fi

# Process new events through filter rules
HAS_OUTPUT=false

tail -n +"$((CURSOR + 1))" "$EVENTS_FILE" | python3 -c "
import sys, json

notifications = []

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except json.JSONDecodeError:
        continue

    e = r.get('event', '')
    a = r.get('action', '')
    n = r.get('number', '')
    title = r.get('title', '')
    user = r.get('user', '')

    # Rule 1: Issue created → triage
    if e == 'issues' and a == 'opened':
        labels = ', '.join(r.get('labels', [])) or 'none'
        notifications.append(f'TRIAGE|New issue #{n}: {title} [labels: {labels}]')

    # Rule 2: Board status → Ready (projects_v2_item — org webhook only)
    elif e == 'projects_v2_item' and a == 'edited':
        field = r.get('field', '')
        new_val = r.get('new_value', '')
        if field == 'Status' and new_val in ('Ready', 'ready'):
            notifications.append(f'DISPATCH|Issue moved to Ready on board (by {user})')

    # Rule 3: Human comment on issue/PR → may need PM response
    elif e == 'issue_comment' and a == 'created' and not r.get('is_bot', False):
        comment_user = r.get('comment_user', '')
        body_preview = r.get('comment_body', '')[:200]
        notifications.append(f'HUMAN_COMMENT|Comment on #{n} by {comment_user}: {body_preview}')
    elif e == 'pull_request_review' and a == 'submitted' and not r.get('is_bot', False):
        review_user = r.get('review_user', '')
        state = r.get('review_state', '')
        body_preview = r.get('review_body', '')[:200]
        notifications.append(f'HUMAN_REVIEW|Review on #{n} by {review_user} ({state}): {body_preview}')

    # Rule 4: CI failed on main → needs investigation
    elif e == 'workflow_run' and a == 'completed':
        conclusion = r.get('conclusion', '')
        branch = r.get('branch', '')
        if conclusion == 'failure' and branch == 'main':
            wf = r.get('workflow_name', '')
            notifications.append(f'CI_FAILED|Workflow \"{wf}\" failed on main')

if notifications:
    for n in notifications:
        print(n)
" && HAS_OUTPUT=true

# Update cursor
echo "$TOTAL" > "$CURSOR_FILE"

# Cleanup: truncate when all events are processed and file is large enough
# Both cursors must be at TOTAL (all events consumed) and file > 50 lines
READ_CURSOR_FILE="$REPO_ROOT/.claude/github-events.cursor"
READ_CURSOR=0
if [ -f "$READ_CURSOR_FILE" ]; then
    READ_CURSOR=$(cat "$READ_CURSOR_FILE")
fi
PROCESS_CURSOR=$(cat "$CURSOR_FILE")

if [ "$TOTAL" -ge 50 ] && [ "$PROCESS_CURSOR" -ge "$TOTAL" ] && [ "$READ_CURSOR" -ge "$TOTAL" ]; then
    : > "$EVENTS_FILE"
    echo "0" > "$CURSOR_FILE"
    echo "0" > "$READ_CURSOR_FILE"
fi

if [ "$HAS_OUTPUT" = true ]; then
    exit 0
else
    exit 1
fi
