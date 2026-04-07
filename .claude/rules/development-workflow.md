# Development Workflow

Dev agents (architect, server-dev, cli-dev) are OpenCara implement agents configured in `.opencara.toml`. They are triggered automatically when an issue moves to "In progress" on the GitHub Project board.

## Lifecycle

1. PM triages issue and sets the "Agent" field on the project board
2. Issue moves to "In progress" (by team lead or PM)
3. `projects_v2_item.edited` webhook fires → server creates implement task
4. CLI agent claims the task and receives the issue context + agent prompt
5. Agent reads the issue and understands the requirements
6. Agent creates branch `issue-<NUMBER>-<short-description>`
7. Agent implements changes with tests
8. Agent runs build and test: `pnpm build && pnpm test`
9. Agent commits, pushes, and creates a PR (referencing the issue)
10. **Self-review**: wait for OpenCara bot review → fix findings → re-review (max 3 iterations)
11. When clean → run pre-merge checks → merge the PR

## Implementation Phase

```bash
# Create branch
git checkout -b issue-<NUMBER>-<short-description>

# ... implement changes ...

# Build and test
pnpm build && pnpm test && pnpm lint && pnpm run format:check && pnpm run typecheck

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

The OpenCara GitHub App is installed on this repo with `.opencara.toml` configured (agent_count: 5). When you push and create a PR, the bot automatically dispatches review agents.

1. After creating the PR, run the bot review wait script:
   ```bash
   scripts/wait-bot-review.sh <PR_NUMBER>
   ```
   The script polls for 20 minutes, then auto-triggers `/opencara review` up to 2 times (5 min wait each). Exit code 0 = review found, exit code 1 = no review after all attempts.
2. **NEVER merge without at least running the wait script.** If the bot truly cannot review after all attempts (no agents online), document this in the PR and proceed with self-review only.

### Step 2: Fix & Re-review (max 3 iterations)

1. Read the bot review findings posted on the PR
2. Perform your own review of the diff, combining bot findings with your analysis
3. Fix all valid issues found (critical, major, minor — not just critical/major)
4. Run tests, commit, push, and re-review until clean
5. If no remaining issues → proceed to merge

### Step 3: Pre-merge Verification

**MANDATORY**: Before merging, run the pre-merge check script:

```bash
scripts/pre-merge-check.sh <PR_NUMBER>
```

The script merges latest main, runs build + test + lint + format + typecheck, then posts a coverage report to the PR. If any check fails, fix the issue before merging.

### Step 4: Merge

```bash
gh pr merge <PR_NUMBER> --squash --delete-branch
```

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
- If the issue spec is unclear, comment on the issue asking PM for clarification
- If an issue requires work outside your scope, comment on the issue explaining what's needed — PM will re-triage
