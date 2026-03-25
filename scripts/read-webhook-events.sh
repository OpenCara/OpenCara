#!/usr/bin/env bash
# Read new GitHub webhook events from the JSONL file and format them
# for PM/team-lead consumption.
#
# Usage:
#   scripts/read-webhook-events.sh              # Show all unread events
#   scripts/read-webhook-events.sh --all        # Show all events (ignore cursor)
#   scripts/read-webhook-events.sh --tail       # Continuously watch for new events
#   scripts/read-webhook-events.sh --clear      # Reset cursor (mark all as read)
#
# The script tracks a cursor (line number) in .claude/github-events.cursor
# so that each invocation only shows events since the last read.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVENTS_FILE="$REPO_ROOT/.claude/github-events.jsonl"
CURSOR_FILE="$REPO_ROOT/.claude/github-events.cursor"

# Parse args
MODE="new"
for arg in "$@"; do
    case "$arg" in
        --all)  MODE="all" ;;
        --tail) MODE="tail" ;;
        --clear) MODE="clear" ;;
        --help|-h)
            echo "Usage: $0 [--all|--tail|--clear]"
            echo "  (default)  Show unread events since last invocation"
            echo "  --all      Show all events"
            echo "  --tail     Continuously watch for new events"
            echo "  --clear    Mark all events as read"
            exit 0
            ;;
    esac
done

if [ "$MODE" = "clear" ]; then
    if [ -f "$EVENTS_FILE" ]; then
        wc -l < "$EVENTS_FILE" > "$CURSOR_FILE"
        echo "Cursor reset. All events marked as read."
    else
        echo "0" > "$CURSOR_FILE"
        echo "No events file. Cursor set to 0."
    fi
    exit 0
fi

if [ ! -f "$EVENTS_FILE" ]; then
    echo "No events yet. Is the webhook server running?"
    echo "  Start it: python3 scripts/github-webhook.py"
    exit 0
fi

if [ "$MODE" = "tail" ]; then
    echo "Watching for new events (Ctrl+C to stop)..."
    tail -f "$EVENTS_FILE" | while IFS= read -r line; do
        echo "$line" | python3 -c "
import sys, json
r = json.loads(sys.stdin.read())
e = r.get('event', '?')
a = r.get('action', '?')
t = r.get('timestamp', '?')[:19]
n = r.get('number', '')
prefix = f'#{n}' if n else ''

if e == 'issues':
    print(f'[{t}] ISSUE {prefix} {a}: {r.get(\"title\", \"\")}')
elif e == 'pull_request':
    merged = '(merged)' if r.get('merged') else ''
    print(f'[{t}] PR {prefix} {a} {merged}: {r.get(\"title\", \"\")}')
elif e == 'issue_comment':
    user = r.get('comment_user', '')
    bot = ' [BOT]' if r.get('is_bot') else ''
    print(f'[{t}] COMMENT {prefix} by {user}{bot}')
elif e == 'pull_request_review':
    user = r.get('review_user', '')
    state = r.get('review_state', '')
    bot = ' [BOT]' if r.get('is_bot') else ''
    print(f'[{t}] REVIEW {prefix} by {user}{bot}: {state}')
elif e == 'push':
    branch = r.get('branch', '')
    count = r.get('commit_count', 0)
    print(f'[{t}] PUSH to {branch}: {count} commit(s)')
    for c in r.get('commits', []):
        print(f'         {c[\"sha\"]} {c[\"message\"]}')
elif e == 'workflow_run':
    name = r.get('workflow_name', '')
    conclusion = r.get('conclusion', '').upper()
    print(f'[{t}] CI {name}: {conclusion} on {r.get(\"branch\", \"\")}')
elif e == 'projects_v2_item':
    field = r.get('field', '')
    old = r.get('old_value', '')
    new = r.get('new_value', '')
    print(f'[{t}] BOARD {field}: {old} -> {new} (by {r.get(\"user\", \"\")})')
else:
    print(f'[{t}] {e}/{a}')
"
    done
    exit 0
fi

# Read cursor
CURSOR=0
if [ "$MODE" = "new" ] && [ -f "$CURSOR_FILE" ]; then
    CURSOR=$(cat "$CURSOR_FILE")
fi

TOTAL=$(wc -l < "$EVENTS_FILE")

if [ "$CURSOR" -ge "$TOTAL" ]; then
    echo "No new events. ($TOTAL total)"
    exit 0
fi

NEW_COUNT=$((TOTAL - CURSOR))
echo "--- $NEW_COUNT new event(s) ---"

tail -n +"$((CURSOR + 1))" "$EVENTS_FILE" | python3 -c "
import sys, json

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    e = r.get('event', '?')
    a = r.get('action', '?')
    t = r.get('timestamp', '?')[:19]
    n = r.get('number', '')
    prefix = f'#{n}' if n else ''

    if e == 'issues':
        print(f'  [{t}] ISSUE {prefix} {a}: {r.get(\"title\", \"\")}')
    elif e == 'pull_request':
        merged = '(merged)' if r.get('merged') else ''
        print(f'  [{t}] PR {prefix} {a} {merged}: {r.get(\"title\", \"\")}')
    elif e == 'issue_comment':
        user = r.get('comment_user', '')
        bot = ' [BOT]' if r.get('is_bot') else ''
        print(f'  [{t}] COMMENT {prefix} by {user}{bot}')
    elif e == 'pull_request_review':
        user = r.get('review_user', '')
        state = r.get('review_state', '')
        bot = ' [BOT]' if r.get('is_bot') else ''
        print(f'  [{t}] REVIEW {prefix} by {user}{bot}: {state}')
    elif e == 'push':
        branch = r.get('branch', '')
        count = r.get('commit_count', 0)
        print(f'  [{t}] PUSH to {branch}: {count} commit(s)')
        for c in r.get('commits', []):
            print(f'           {c[\"sha\"]} {c[\"message\"]}')
    elif e == 'workflow_run':
        name = r.get('workflow_name', '')
        conclusion = r.get('conclusion', '').upper()
        print(f'  [{t}] CI {name}: {conclusion} on {r.get(\"branch\", \"\")}')
    elif e == 'projects_v2_item':
        field = r.get('field', '')
        old = r.get('old_value', '')
        new = r.get('new_value', '')
        print(f'  [{t}] BOARD {field}: {old} -> {new} (by {r.get(\"user\", \"\")})')
    else:
        print(f'  [{t}] {e}/{a}')
"

# Update cursor
echo "$TOTAL" > "$CURSOR_FILE"
echo "--- cursor updated to $TOTAL ---"
