#!/usr/bin/env bash
# Clean up a git worktree and its branch after an agent completes.
# Usage: scripts/cleanup-worktree.sh <worktree-path>
# Example: scripts/cleanup-worktree.sh .claude/worktrees/cli-dev-380
# Exit codes:
#   0 — cleaned up successfully
#   1 — worktree not found

set -euo pipefail

WORKTREE_PATH="${1:?Usage: scripts/cleanup-worktree.sh <worktree-path>}"

if [ ! -d "$WORKTREE_PATH" ]; then
  echo "Worktree not found: $WORKTREE_PATH"
  exit 1
fi

# Get the branch name before removing the worktree
BRANCH=$(git -C "$WORKTREE_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || true)

# Remove the worktree (force in case of untracked files from build artifacts)
echo "Removing worktree: $WORKTREE_PATH"
git worktree remove "$WORKTREE_PATH" --force

# Delete the branch if it still exists (squash merges delete remote but not local)
if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ] && git show-ref --verify --quiet "refs/heads/$BRANCH" 2>/dev/null; then
  echo "Deleting branch: $BRANCH"
  git branch -D "$BRANCH"
fi

echo "Cleanup complete."
