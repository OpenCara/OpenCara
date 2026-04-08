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
10. **STOP** — agent shuts down after creating the PR

**Post-PR phases are handled by PM** (not the implement agent):

- PM waits for OpenCara bot review
- PM comments `/opencara fix` to trigger fix agent for review findings + merge conflicts
- PM checks if PR is clean → merges with `gh pr merge --squash --delete-branch` (max 3 fix iterations)

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

## Post-PR: Review/Fix/Merge (PM-Orchestrated)

After the implement agent creates a PR and shuts down, **PM handles the rest**:

1. **Bot review** — OpenCara bot automatically reviews the PR (5 agents)
2. **Fix agent** — PM comments `/opencara fix` to trigger the fix agent, which resolves review findings + merge conflicts
3. **Merge** — PM merges with `gh pr merge <PR> --squash --delete-branch` when the PR is clean
4. **Iterate** — if still dirty after fix, PM repeats the fix cycle (max 3 iterations)

Implement agents do NOT wait for bot review, do NOT self-review, and do NOT merge.

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
