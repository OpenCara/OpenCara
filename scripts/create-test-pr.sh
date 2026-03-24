#!/usr/bin/env bash
# Create a throwaway test PR on a target repo for QA smoke testing.
# Usage: scripts/create-test-pr.sh [--repo OWNER/REPO]
# Defaults to OpenCara/opencara-dev-test.
# Outputs the PR number on success.
# Exit codes:
#   0 — test PR created
#   1 — failed to create

set -euo pipefail

REPO="OpenCara/opencara-dev-test"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

BRANCH="qa-test-$(date +%s)"

echo "Creating test PR on $REPO (branch: $BRANCH)..."

# Create branch from main HEAD
MAIN_SHA=$(gh api "repos/$REPO/git/ref/heads/main" --jq '.object.sha')
gh api "repos/$REPO/git/refs" -X POST -f ref="refs/heads/$BRANCH" -f sha="$MAIN_SHA" > /dev/null

# Push a dummy commit
README_SHA=$(gh api "repos/$REPO/contents/README.md" --jq '.sha')
CONTENT=$(echo -e "# test\n<!-- QA smoke test $(date -Iseconds) -->" | base64 -w0)
gh api "repos/$REPO/contents/README.md" -X PUT \
  -f message="test: QA smoke test" \
  -f content="$CONTENT" \
  -f sha="$README_SHA" \
  -f branch="$BRANCH" > /dev/null

# Create the PR and extract its number
PR_URL=$(gh pr create --repo "$REPO" --base main --head "$BRANCH" \
  --title "QA smoke test" --body "Automated QA verification." 2>&1 | tail -1)
PR_NUM=$(echo "$PR_URL" | grep -oP '\d+$')

echo "Test PR created: #$PR_NUM ($REPO)"
echo "$PR_NUM"
