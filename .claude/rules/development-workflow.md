# Development Workflow

All dev agents (architect, server-dev, cli-dev) follow this standard lifecycle.

## Lifecycle

1. Spawned by PM in an isolated **git worktree** (auto-created branch)
2. Receive an issue number from PM (issue body contains detailed specs from PM)
3. Read the issue and understand the requirements
4. Rename the worktree branch to `issue-<NUMBER>-<short-description>`
5. Implement the changes
6. Write tests for new code
7. Build and test: `pnpm build && pnpm test`
8. Commit, push, and create a PR (referencing the issue)
9. **Self-review**: wait for OpenCara bot review → fix findings → re-review (max 3 iterations)
10. When clean → merge the PR
11. Shut down

**CRITICAL**: You are always running in a worktree — NEVER modify files in the root project directory. All work MUST happen in your agent's worktree. The root project must always stay on the `main` branch — never check out other branches there. If you find yourself working in the root project, STOP immediately.

## Implementation Phase

```bash
# Rename the auto-created worktree branch
git branch -m issue-<NUMBER>-<short-description>

# ... implement changes ...

# Build and test
pnpm build && pnpm test

# Commit with issue reference (do NOT use "Closes" or "Fixes" — PM manages issue lifecycle)
git add <specific files>
git commit -m "<description>

Part of #<NUMBER>"

# Push and create PR — use your agent name as prefix: [architect], [server-dev], [cli-dev]
# IMPORTANT: Always label PRs and issues with your agent name (e.g., agent:architect)
# IMPORTANT: Do NOT use "Closes #N" or "Fixes #N" in PR body — PM manages issue status
git push -u origin issue-<NUMBER>-<short-description>
gh pr create --title "[<agent-name>] <title>" --label "agent:<agent-name>" --body "Part of #<NUMBER>

## Summary
- ...

## Test plan
- ..."
```

**Version bumps are manual** — do NOT bump versions in PRs. The team lead controls version numbers.

## Self-Review Phase

After creating the PR, the OpenCara GitHub App (our own product) automatically reviews it. Wait for the bot review, then self-review combining its findings with your own analysis.

### Step 1: Wait for OpenCara Bot Review

The OpenCara GitHub App is installed on this repo with `.review.yml` configured (review_count: 3). When you push and create a PR, the bot automatically dispatches review agents.

1. After creating the PR, wait for the OpenCara bot review to appear:
   ```bash
   # Poll for bot review (check every 30s, up to 20 minutes)
   # Check both PR reviews and issue comments — the bot may use either
   for i in $(seq 1 40); do
     PR_REVIEWS=$(gh api repos/OpenCara/OpenCara/pulls/<PR_NUMBER>/reviews --jq '[.[] | select(.user.login == "opencara[bot]")] | length' 2>/dev/null || echo 0)
     COMMENTS=$(gh api repos/OpenCara/OpenCara/issues/<PR_NUMBER>/comments --jq '[.[] | select(.user.login == "opencara[bot]")] | length' 2>/dev/null || echo 0)
     TOTAL=$((PR_REVIEWS + COMMENTS))
     if [ "$TOTAL" -gt 0 ]; then echo "Bot review found ($PR_REVIEWS review(s), $COMMENTS comment(s))"; break; fi
     echo "Waiting for bot review... ($i/40)"
     sleep 30
   done
   ```
2. If no review after 20 minutes, trigger manually with `/opencara review` and wait another 5 minutes:
   ```bash
   gh pr comment <PR_NUMBER> --body "/opencara review"
   sleep 300
   ```
3. If still no review after the manual trigger, request a second manual review before proceeding:
   ```bash
   gh pr comment <PR_NUMBER> --body "/opencara review"
   sleep 300
   ```
4. **NEVER merge without at least checking for the bot review.** If the bot truly cannot review after both attempts (no agents online), document this in the PR and proceed with self-review only.

### Step 2: Fix & Re-review (max 3 iterations)

1. Read the bot review findings posted on the PR
2. Perform your own review of the diff, combining bot findings with your analysis
3. Fix all valid issues found (critical, major, minor — not just critical/major)
4. Run tests, commit, push, and re-review until clean
5. If no remaining issues → proceed to merge

### Step 3: Pre-merge Verification

**MANDATORY**: Before merging, pull latest main and run the full test suite locally:

```bash
git fetch origin main
git merge origin/main
pnpm build && pnpm test && pnpm lint && pnpm run format:check && pnpm run typecheck
```

If any check fails, fix the issue before merging. Do NOT merge with failing tests.

After all checks pass, run coverage and post the report to the PR:

````bash
pnpm vitest run --coverage 2>&1 | tail -40 > /tmp/coverage-report.txt
gh pr comment <PR_NUMBER> --body "$(printf '## Coverage Report\n\n```\n'; cat /tmp/coverage-report.txt; printf '```\n')"
rm -f /tmp/coverage-report.txt
````

### Step 4: Merge

```bash
gh pr merge <PR_NUMBER> --squash --delete-branch
```

### Step 5: Report Completion to PM

After merging, notify PM so it can update project status and dispatch any newly unblocked issues:

```
SendMessage to PM: "Completed issue #<NUMBER>. PR #<PR_NUMBER> merged (squash). Ready for shutdown."
```

PM will then move the issue to **In review** status on the GitHub Project board and schedule QA verification. This enables PM to dispatch dependent work without waiting for the GitHub webhook round-trip.

## QA Process

QA verifies issues that are in **In review** status on the GitHub Project board. No separate checklist issue is needed — the project board IS the checklist.

1. PM spawns QA agent with the list of **In review** issues
2. QA verifies each issue one-by-one against its acceptance criteria
3. QA reports per-issue PASS/FAIL to PM
4. PM moves verified issues to **Done**, failed issues back to **In progress**

## Auto-Deploy

The dev worker (`opencara-server-dev`) is automatically deployed when code is merged to `main` via the `deploy-dev.yml` GitHub Actions workflow. No manual deployment is needed for dev. The `scripts/deploy-worker.sh` script remains available for manual and production deployments.

## Push to Main Rule

**ALL pushes to main must pass local checks first** — no exceptions. This applies to dev agents merging PRs, PM direct-committing docs, and team lead pushing config changes.

Before any `git push origin main`:

```bash
pnpm build && pnpm test && pnpm lint && pnpm run format:check && pnpm run typecheck
```

If any check fails, fix it before pushing. Never push broken code to main.

## Architecture Principles

- **TypeScript strict mode** — all packages use `"strict": true`
- **Shared types are the contract** — `packages/shared` defines REST API types used by all packages
- **Zero runtime dependencies in shared** — `packages/shared` is pure TypeScript types and utilities
- **REST-only, no WebSocket** — stateless HTTP polling, no Durable Objects, no persistent connections
- **D1 (SQL) is the primary data store** — DataStore abstraction supports D1 and in-memory backends; KVDataStore was removed
- **CLI is a polling client** — polls server for tasks, executes reviews locally, submits results via REST

## Common Guidelines

- Follow **SOLID**, **KISS**, **YAGNI** principles
- Use Vitest for unit tests across all packages — **test coverage must be close to 100%**. Run `pnpm vitest run --coverage` to verify before creating PRs
- ESLint + Prettier for code quality (run `pnpm lint` before committing)
- If the issue spec is unclear, comment on the issue asking PM for clarification and shut down
- If an issue requires work outside your scope, comment on the issue explaining what's needed and shut down — PM will re-triage
