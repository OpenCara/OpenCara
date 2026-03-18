# Development Workflow

All dev agents (architect, worker-dev, cli-dev, web-dev) follow this standard lifecycle.

## Lifecycle

1. Spawned by PM in an isolated **git worktree** (auto-created branch)
2. Receive an issue number from PM (issue body contains detailed specs from PM)
3. Read the issue and understand the requirements
4. Rename the worktree branch using the version bump convention:
   - New features / enhancements → `feat/<NUMBER>-<short-description>`
   - Bug fixes → `fix/<NUMBER>-<short-description>`
   - Breaking changes → `breaking/<NUMBER>-<short-description>`
     This determines the version bump when the PR is merged (feat=minor, fix=patch, breaking=major).
5. Implement the changes
6. Write tests for new code
7. Build and test: `pnpm build && pnpm test`
8. Commit, push, and create a PR (referencing the issue)
9. **Self-review**: run multi-AI review → fix findings → re-review (max 3 iterations)
10. When clean → merge the PR
11. Shut down

**CRITICAL**: You are always running in a worktree — NEVER modify files in the root project directory. All work MUST happen in your agent's worktree. The root project must always stay on the `main` branch — never check out other branches there. If you find yourself working in the root project, STOP immediately.

## Implementation Phase

```bash
# Rename the auto-created worktree branch using version bump convention:
# - feat/<NUMBER>-<desc> for new features/enhancements (triggers minor version bump)
# - fix/<NUMBER>-<desc> for bug fixes (triggers patch version bump)
# - breaking/<NUMBER>-<desc> for breaking changes (triggers major version bump)
git branch -m feat/<NUMBER>-<short-description>  # or fix/ or breaking/

# ... implement changes ...

# Build and test
pnpm build && pnpm test

# Commit with issue reference
git add <specific files>
git commit -m "<description>

Closes #<NUMBER>"

# Push and create PR — use your agent name as prefix: [architect], [worker-dev], [cli-dev], [web-dev]
# IMPORTANT: Always label PRs and issues with your agent name (e.g., agent:architect)
git push -u origin feat/<NUMBER>-<short-description>
gh pr create --title "[<agent-name>] <title>" --label "agent:<agent-name>" --body "Closes #<NUMBER>

## Summary
- ...

## Test plan
- ..."
```

## Self-Review Phase

After creating the PR, review your own changes using the `/multi-agents:review-pr` skill.

### Step 1: Run Multi-AI Review

Use the `/multi-agents:review-pr` skill to run a comprehensive multi-agent review:

```
/multi-agents:review-pr <PR_NUMBER>
```

This skill automatically:

- Fetches PR diff and metadata
- Launches all configured AI agents (Codex, Gemini, Qwen variants) in parallel
- Deduplicates and categorizes findings by severity (critical/major/minor)
- Posts structured inline review comments via `gh pr-review` (threaded on specific file+line locations)
- Falls back to a single synthesized comment if inline review is unavailable

**CRITICAL**: You MUST wait for ALL review agents to complete before proceeding. Do NOT move on after the first agent (typically Codex) finishes. Collect results from every agent via `TaskOutput` one at a time. If an agent times out after 600s, note it as "did not complete" and proceed with the rest — but never skip waiting. Killing background review tasks prematurely is a workflow violation.

### Step 2: Fix & Re-review (max 3 iterations)

1. Read the review findings posted on the PR
2. If no critical/major issues → proceed to merge
3. Otherwise: fix issues, run tests, commit, push, and re-review the changes yourself (agent-only review — do NOT re-run `/multi-agents:review-pr` on subsequent iterations)

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

After merging, notify PM so it can immediately dispatch any newly unblocked issues:

```
SendMessage to PM: "Completed issue #<NUMBER>. PR #<PR_NUMBER> merged (squash). Ready for shutdown."
```

This enables PM to dispatch dependent work without waiting for the GitHub webhook round-trip.

## Push to Main Rule

**ALL pushes to main must pass local checks first** — no exceptions. This applies to dev agents merging PRs, PM direct-committing docs, and team lead pushing config changes.

Before any `git push origin main`:

```bash
pnpm build && pnpm test && pnpm lint && pnpm run format:check && pnpm run typecheck
```

If any check fails, fix it before pushing. Never push broken code to main.

## Architecture Principles

- **TypeScript strict mode** — all packages use `"strict": true`
- **Shared types are the contract** — `packages/shared` defines protocol types used by all packages
- **Zero runtime dependencies in shared** — `packages/shared` is pure TypeScript types and utilities
- **Workers are stateless** — all state lives in Durable Objects, KV, or Supabase
- **CLI is a thin client** — business logic lives in the Worker, CLI handles local execution and WebSocket

## Common Guidelines

- Follow **SOLID**, **KISS**, **YAGNI** principles
- Use Vitest for unit tests across all packages — **test coverage must be close to 100%**. Run `pnpm vitest run --coverage` to verify before creating PRs
- ESLint + Prettier for code quality (run `pnpm lint` before committing)
- If the issue spec is unclear, comment on the issue asking PM for clarification and shut down
- If an issue requires work outside your scope, comment on the issue explaining what's needed and shut down — PM will re-triage
