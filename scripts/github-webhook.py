#!/usr/bin/env python3
"""
Lightweight GitHub webhook receiver for OpenCara.
Appends filtered GitHub events to a JSONL file for the PM agent to consume.

Usage:
    python3 scripts/github-webhook.py [--port 8766] [--secret YOUR_SECRET]

The JSONL file is written to .claude/github-events.jsonl by default.
Each line is a JSON object with: {timestamp, event, action, summary, ...}

Set GITHUB_WEBHOOK_SECRET env var or pass --secret for signature verification.

Supported events:
    issues          — opened, closed, labeled, assigned, reopened
    pull_request    — opened, closed, merged, review_requested, synchronize
    issue_comment   — created (especially from opencara[bot])
    pull_request_review — submitted
    push            — to main/master branch
    workflow_run    — completed (CI pass/fail)
    projects_v2_item — status changes on project board
"""

import argparse
import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Resolve paths relative to repo root (parent of scripts/)
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EVENTS_FILE = REPO_ROOT / ".claude" / "github-events.jsonl"

RELEVANT_EVENTS = {
    "issues",
    "pull_request",
    "issue_comment",
    "pull_request_review",
    "push",
    "workflow_run",
    "projects_v2_item",
}


def verify_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify GitHub webhook HMAC-SHA256 signature."""
    if not signature.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


def format_summary(event_type: str, action: str, record: dict) -> str:
    """Format a one-line human-readable summary for console output."""
    num = record.get("number")
    prefix = f"#{num}" if num else ""

    if event_type == "issues":
        return f"Issue {prefix} {action}: {record.get('title', '')}"
    elif event_type == "pull_request":
        merged = record.get("merged", False)
        if action == "closed" and merged:
            return f"PR {prefix} merged: {record.get('title', '')}"
        return f"PR {prefix} {action}: {record.get('title', '')}"
    elif event_type == "issue_comment":
        user = record.get("comment_user", "")
        return f"Comment on {prefix} by {user}"
    elif event_type == "pull_request_review":
        user = record.get("review_user", "")
        state = record.get("review_state", "")
        return f"Review on {prefix} by {user}: {state}"
    elif event_type == "push":
        branch = record.get("branch", "")
        count = record.get("commit_count", 0)
        return f"Push to {branch}: {count} commit(s) by {record.get('user', '')}"
    elif event_type == "workflow_run":
        name = record.get("workflow_name", "")
        conclusion = record.get("conclusion", "")
        return f"Workflow '{name}' {conclusion} on {record.get('branch', '')}"
    elif event_type == "projects_v2_item":
        return f"Board change: {record.get('field', '')} -> {record.get('new_value', '')} (by {record.get('user', '')})"
    return f"{event_type}/{action}"


def extract_record(event_type: str, data: dict) -> dict | None:
    """Extract a structured record from a webhook payload. Returns None to skip."""
    action = data.get("action", "unknown")

    if event_type == "issues":
        item = data.get("issue", {})
        return {
            "event": event_type,
            "action": action,
            "number": item.get("number"),
            "title": item.get("title", ""),
            "url": item.get("html_url", ""),
            "labels": [l.get("name", "") for l in item.get("labels", [])],
            "user": data.get("sender", {}).get("login", ""),
            "state": item.get("state", ""),
            "body": (item.get("body") or "")[:500],
        }

    elif event_type == "pull_request":
        item = data.get("pull_request", {})
        return {
            "event": event_type,
            "action": action,
            "number": item.get("number"),
            "title": item.get("title", ""),
            "url": item.get("html_url", ""),
            "labels": [l.get("name", "") for l in item.get("labels", [])],
            "user": data.get("sender", {}).get("login", ""),
            "head_branch": item.get("head", {}).get("ref", ""),
            "base_branch": item.get("base", {}).get("ref", ""),
            "merged": item.get("merged", False),
            "body": (item.get("body") or "")[:500],
        }

    elif event_type == "issue_comment":
        if action != "created":
            return None  # Only care about new comments
        item = data.get("issue", {})
        comment = data.get("comment", {})
        return {
            "event": event_type,
            "action": action,
            "number": item.get("number"),
            "title": item.get("title", ""),
            "url": comment.get("html_url", ""),
            "user": data.get("sender", {}).get("login", ""),
            "comment_body": (comment.get("body") or "")[:500],
            "comment_user": comment.get("user", {}).get("login", ""),
            "is_bot": comment.get("user", {}).get("type", "") == "Bot",
        }

    elif event_type == "pull_request_review":
        if action != "submitted":
            return None
        item = data.get("pull_request", {})
        review = data.get("review", {})
        return {
            "event": event_type,
            "action": action,
            "number": item.get("number"),
            "title": item.get("title", ""),
            "url": review.get("html_url", ""),
            "user": data.get("sender", {}).get("login", ""),
            "review_state": review.get("state", ""),
            "review_body": (review.get("body") or "")[:500],
            "review_user": review.get("user", {}).get("login", ""),
            "is_bot": review.get("user", {}).get("type", "") == "Bot",
        }

    elif event_type == "push":
        ref = data.get("ref", "")
        branch = ref.replace("refs/heads/", "")
        # Only care about pushes to main
        if branch not in ("main", "master"):
            return None
        commits = data.get("commits", [])
        return {
            "event": event_type,
            "action": "push",
            "branch": branch,
            "user": data.get("sender", {}).get("login", ""),
            "commit_count": len(commits),
            "commits": [
                {
                    "sha": c.get("id", "")[:8],
                    "message": c.get("message", "").split("\n")[0],
                    "author": c.get("author", {}).get("username", ""),
                }
                for c in commits[:10]  # Cap at 10 commits
            ],
            "compare_url": data.get("compare", ""),
        }

    elif event_type == "workflow_run":
        if action != "completed":
            return None
        run = data.get("workflow_run", {})
        return {
            "event": event_type,
            "action": action,
            "workflow_name": run.get("name", ""),
            "conclusion": run.get("conclusion", ""),
            "branch": run.get("head_branch", ""),
            "url": run.get("html_url", ""),
            "user": data.get("sender", {}).get("login", ""),
            "run_number": run.get("run_number"),
        }

    elif event_type == "projects_v2_item":
        changes = data.get("changes", {})
        field = changes.get("field_value", {}).get("field_name", "")
        old_value = changes.get("field_value", {}).get("from", {})
        new_value = changes.get("field_value", {}).get("to", {})
        # Extract readable values (board column names, etc.)
        old_name = old_value.get("name", str(old_value)) if isinstance(old_value, dict) else str(old_value)
        new_name = new_value.get("name", str(new_value)) if isinstance(new_value, dict) else str(new_value)
        return {
            "event": event_type,
            "action": action,
            "field": field,
            "old_value": old_name,
            "new_value": new_name,
            "user": data.get("sender", {}).get("login", ""),
            "project_item_id": data.get("projects_v2_item", {}).get("id", ""),
        }

    return None


class WebhookHandler(BaseHTTPRequestHandler):
    """Handle GitHub webhook POST requests."""

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        payload = self.rfile.read(content_length)

        # Verify signature if secret is configured
        secret = self.server.webhook_secret
        if secret:
            signature = self.headers.get("X-Hub-Signature-256", "")
            if not verify_signature(payload, signature, secret):
                self.send_response(403)
                self.end_headers()
                self.wfile.write(b"Invalid signature")
                return

        event_type = self.headers.get("X-GitHub-Event", "unknown")

        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Invalid JSON")
            return

        # Only process relevant event types
        if event_type not in RELEVANT_EVENTS:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Ignored event type")
            return

        record = extract_record(event_type, data)
        if record is None:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Filtered out")
            return

        record["timestamp"] = datetime.now(timezone.utc).isoformat()

        # Append to JSONL file
        events_file = self.server.events_file
        events_file.parent.mkdir(parents=True, exist_ok=True)
        with open(events_file, "a") as f:
            f.write(json.dumps(record) + "\n")

        summary = format_summary(event_type, record.get("action", ""), record)
        print(f"[{record['timestamp']}] {summary}")

        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")

    def do_GET(self):
        """Health check endpoint."""
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"GitHub webhook receiver is running")

    def log_message(self, format, *args):
        """Suppress default request logging (we log our own)."""
        pass


def main():
    parser = argparse.ArgumentParser(description="GitHub webhook receiver for OpenCara")
    parser.add_argument("--port", type=int, default=8766, help="Port to listen on (default: 8766)")
    parser.add_argument("--secret", type=str, default=os.environ.get("GITHUB_WEBHOOK_SECRET", ""),
                        help="Webhook secret for signature verification (or set GITHUB_WEBHOOK_SECRET env var)")
    parser.add_argument("--events-file", type=str, default=str(DEFAULT_EVENTS_FILE),
                        help=f"Path to JSONL events file (default: {DEFAULT_EVENTS_FILE})")
    args = parser.parse_args()

    server = HTTPServer(("0.0.0.0", args.port), WebhookHandler)
    server.webhook_secret = args.secret
    server.events_file = Path(args.events_file)

    print(f"Listening on port {args.port}")
    print(f"Events file: {server.events_file}")
    print(f"Tracked events: {', '.join(sorted(RELEVANT_EVENTS))}")
    if server.webhook_secret:
        print("Signature verification: enabled")
    else:
        print("Signature verification: disabled (no secret configured)")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down")
        server.server_close()


if __name__ == "__main__":
    main()
