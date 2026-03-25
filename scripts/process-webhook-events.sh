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
# Filter rules:
#   1. Issue created → "TRIAGE: New issue #N: <title>"
#   2. Board status → Ready → "DISPATCH: Issue #N moved to Ready: <title>"
#   3. PR opened → "PR_OPENED: PR #N: <title>"
#   4. PR merged → "PR_MERGED: PR #N merged: <title>"
#   5. Bot review posted → "BOT_REVIEW: Review on PR #N by <user>"
#   6. CI completed (failure) → "CI_FAILED: <workflow> failed on <branch>"
#   7. Push to main → "PUSH: <count> commit(s) pushed to main"

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

    # Rule 3: PR opened
    elif e == 'pull_request' and a == 'opened':
        notifications.append(f'PR_OPENED|PR #{n} opened: {title} (by {user})')

    # Rule 4: PR merged
    elif e == 'pull_request' and a == 'closed' and r.get('merged', False):
        notifications.append(f'PR_MERGED|PR #{n} merged: {title}')

    # Rule 5: Bot review posted
    elif e == 'issue_comment' and a == 'created' and r.get('is_bot', False):
        bot_user = r.get('comment_user', '')
        notifications.append(f'BOT_REVIEW|Bot comment on #{n} by {bot_user}')
    elif e == 'pull_request_review' and a == 'submitted' and r.get('is_bot', False):
        bot_user = r.get('review_user', '')
        state = r.get('review_state', '')
        notifications.append(f'BOT_REVIEW|Bot review on #{n} by {bot_user}: {state}')

    # Rule 6: CI failed
    elif e == 'workflow_run' and a == 'completed':
        conclusion = r.get('conclusion', '')
        if conclusion == 'failure':
            wf = r.get('workflow_name', '')
            branch = r.get('branch', '')
            notifications.append(f'CI_FAILED|Workflow \"{wf}\" failed on {branch}')

    # Rule 7: Push to main
    elif e == 'push':
        count = r.get('commit_count', 0)
        branch = r.get('branch', '')
        commits = r.get('commits', [])
        summary = '; '.join(c.get('message', '')[:60] for c in commits[:3])
        notifications.append(f'PUSH|{count} commit(s) to {branch}: {summary}')

if notifications:
    for n in notifications:
        print(n)
" && HAS_OUTPUT=true

# Update cursor
echo "$TOTAL" > "$CURSOR_FILE"

if [ "$HAS_OUTPUT" = true ]; then
    exit 0
else
    exit 1
fi
