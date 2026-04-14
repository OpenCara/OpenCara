# Development Workflow

Dev agents (architect, server-dev, cli-dev) are Claude Code team agents spawned by the team lead in worktrees. PM triages and specs issues, then asks the team lead to spawn agents.

## Lifecycle

1. PM triages issue, writes implementation spec, and notifies team lead
2. Team lead spawns a Claude Code agent in a worktree: `/spawn <agent-type> <issue-number>`
3. Agent reads the issue and understands the requirements
4. Agent creates branch `issue-<NUMBER>-<short-description>`
5. Agent implements changes with tests
6. Agent runs build and test: `pnpm build && pnpm test`
7. Agent commits, pushes, and creates a PR (referencing the issue)
8. Agent waits for OpenCara bot review
9. Agent fixes review findings (max 3 iterations)
10. Agent reports back — team lead or PM merges when clean

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

## Post-PR: Review/Fix Loop (Agent-Owned)

After creating the PR, the dev agent handles the review/fix loop:

1. **Wait for bot review** — OpenCara bot automatically reviews the PR (multiple agents)
2. **Read review findings** — check PR comments for the OpenCara review
3. **Fix findings** — address proven defects and major issues from the review
4. **Push fixes** — commit and push to the same branch, re-run build/test
5. **Iterate** — repeat fix cycle until clean (max 3 iterations)
6. **Report back** — notify team lead that PR is ready to merge (agent does NOT merge)

Dev agents wait for bot review, fix findings, but do NOT merge — team lead or PM merges.

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
