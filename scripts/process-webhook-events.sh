#!/usr/bin/env bash
# Process webhook events and output PM-actionable notifications.
# Reads all events from .claude/github-events.jsonl, filters them,
# prints notifications, then truncates the file.
# Prints notifications to stdout if any; silent otherwise. Always exits 0.
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

if [ ! -f "$EVENTS_FILE" ] || [ ! -s "$EVENTS_FILE" ]; then
    exit 0
fi

# Process all events through filter rules
HAS_OUTPUT=false

python3 -c "
import sys, json

notifications = []

for line in open('$EVENTS_FILE'):
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

# Truncate — all events consumed
: > "$EVENTS_FILE"

exit 0
