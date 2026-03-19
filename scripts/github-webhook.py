#!/usr/bin/env python3
"""
Lightweight GitHub webhook receiver for OpenCara.
Appends issue/PR/comment events to a JSONL file for the PM agent to consume.

Usage:
    python3 scripts/github-webhook.py [--port 8765] [--secret YOUR_SECRET]

The JSONL file is written to .claude/github-events.jsonl by default.
Each line is a JSON object with: {timestamp, event, action, number, title, url, labels, user, body}

Set GITHUB_WEBHOOK_SECRET env var or pass --secret for signature verification.
"""

import argparse
import hashlib
import hmac
import json
import os
import sys
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Resolve paths relative to repo root (parent of scripts/)
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EVENTS_FILE = REPO_ROOT / ".claude" / "github-events.jsonl"


def verify_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify GitHub webhook HMAC-SHA256 signature."""
    if not signature.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


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
        if event_type not in ("issues", "pull_request", "issue_comment", "pull_request_review"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Ignored event type")
            return

        action = data.get("action", "unknown")

        # Extract common fields based on event type
        if event_type == "issues":
            item = data.get("issue", {})
        elif event_type == "pull_request":
            item = data.get("pull_request", {})
        elif event_type == "issue_comment":
            item = data.get("issue", {})
        elif event_type == "pull_request_review":
            item = data.get("pull_request", {})
        else:
            item = {}

        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event_type,
            "action": action,
            "number": item.get("number"),
            "title": item.get("title", ""),
            "url": item.get("html_url", ""),
            "labels": [l.get("name", "") for l in item.get("labels", [])],
            "user": data.get("sender", {}).get("login", ""),
            "body": (item.get("body") or "")[:500],  # truncate long bodies
        }

        # PR-specific fields
        if event_type == "pull_request":
            record["head_branch"] = item.get("head", {}).get("ref", "")
            record["base_branch"] = item.get("base", {}).get("ref", "")
            record["merged"] = item.get("merged", False)

        # Comment-specific fields
        if event_type == "issue_comment":
            comment = data.get("comment", {})
            record["comment_body"] = (comment.get("body") or "")[:500]
            record["comment_user"] = comment.get("user", {}).get("login", "")

        # Review-specific fields
        if event_type == "pull_request_review":
            review = data.get("review", {})
            record["review_state"] = review.get("state", "")
            record["review_body"] = (review.get("body") or "")[:500]
            record["review_user"] = review.get("user", {}).get("login", "")

        # Append to JSONL file
        events_file = self.server.events_file
        events_file.parent.mkdir(parents=True, exist_ok=True)
        with open(events_file, "a") as f:
            f.write(json.dumps(record) + "\n")

        print(f"[{record['timestamp']}] {event_type}/{action} #{record['number']}: {record['title']}")

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
