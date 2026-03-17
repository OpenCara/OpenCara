# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenCara is a distributed AI code review service. Contributors run review agents locally (using their own API keys), the platform coordinates multi-agent reviews on GitHub PRs, and a reputation system ranks agents via emoji ratings.

## Tech Stack

- **Backend**: Cloudflare Workers + Durable Objects (TypeScript)
- **Database**: PostgreSQL via Supabase + Supabase Auth (GitHub OAuth)
- **Cache/Storage**: Cloudflare Workers KV + R2
- **Frontend**: Next.js on Vercel
- **CLI**: npm package (TypeScript)
- **Monorepo**: pnpm workspaces

## Planned Monorepo Structure

```
packages/
  worker/    — Cloudflare Workers backend (webhook, REST API, Durable Objects)
  cli/       — Agent CLI (login, agent management, WebSocket client)
  web/       — Next.js dashboard (leaderboard, stats)
  shared/    — Shared types and WebSocket protocol definitions
```

## Architecture

### Core Data Flow

```
GitHub PR Webhook → Cloudflare Worker → Supabase (match agents)
  → Durable Objects (filter online) → FIFO distribute to agents
  → Agents review locally → Results back to platform → GitHub PR comment
```

### Key Protocols

- **WebSocket** between platform and agent CLI: `review_request`, `summary_request`, `heartbeat_ping` (platform→agent); `review_complete`, `summary_complete`, `review_rejected`, `review_error`, `heartbeat_pong` (agent→platform)
- **REST API**: `/webhook/github`, `/api/agents`, `/api/tasks`, `/api/stats/:agentId`, `/api/leaderboard`

### Database Schema (9 tables)

`users`, `agents`, `projects`, `review_tasks`, `review_results`, `review_summaries`, `ratings`, `reputation_history`, `consumption_logs` — full schema in `docs/architecture.md`.

### Trust & Reputation

- Two-tier: agent-level (per model+tool config) and user-level (aggregate)
- Wilson confidence interval for reputation scoring
- Emoji reactions on reviews drive ratings (👍 +1, 👎 -1)
- Self-hosted runner model: platform never touches contributor API keys

## Design Documents

- `docs/product.md` — Product design, UX flows, `.review.yml` config spec
- `docs/architecture.md` — Full technical architecture, DB schema, API contracts
- `docs/mvp.md` — MVP milestone plan (M0–M9) with acceptance criteria

## Build & Test Commands

```bash
pnpm install             # Install all dependencies
pnpm build               # Build all packages
pnpm test                # Run all tests (Vitest)
pnpm lint                # ESLint across all packages
pnpm run typecheck       # TypeScript type checking
pnpm run format          # Prettier formatting
pnpm run format:check    # Check formatting
```

Package-specific:

```bash
cd packages/worker && pnpm dev             # Local Worker dev server
cd packages/web && pnpm dev                # Local Next.js dev server
cd packages/cli && pnpm dev                # CLI development mode
```

## Code Style

- TypeScript strict mode across all packages
- ESLint + Prettier for formatting
- Vitest for testing

## Agent Team

Event-driven, PM-centric multi-agent workflow. All agents defined in `.claude/agents/`.

| Agent          | Role                                               | Lifecycle            |
| -------------- | -------------------------------------------------- | -------------------- |
| **pm**         | Coordinator — triages, designs, dispatches, tracks | Long-running         |
| **architect**  | Shared types, protocol, infrastructure             | Ephemeral (worktree) |
| **worker-dev** | Cloudflare Workers backend                         | Ephemeral (worktree) |
| **cli-dev**    | CLI npm package                                    | Ephemeral (worktree) |
| **web-dev**    | Next.js dashboard                                  | Ephemeral (worktree) |
| **qa**         | Post-merge verification                            | Ephemeral (worktree) |
| **clarifier**  | Multi-AI issue analysis                            | Ephemeral            |

All agents inherit their model and context window from the team lead.

### Agent Rules

- Only one PM at a time; PM never implements code, only plans and dispatches
- Use `/spawn <agent-type> [issue-number]` to spawn agents
- Team lead stays on `main`; dev agents work only in worktrees
- After creating a PR, agents run multi-AI self-review (`/simplify` or manual multi-AI review)
- Team name: `opencara-dev`

### Worktree Isolation (CRITICAL)

- Dev agents MUST work in worktrees — never modify the root project `/home/quabug/opencara/`
- Root project must always stay on `main` branch
- Pre-create worktrees from root project directory, never from inside another worktree:
  ```bash
  cd /home/quabug/opencara
  git pull origin main
  git worktree add .claude/worktrees/<name> origin/main -b <branch-name>
  ```
- Each parallel agent needs its own unique worktree

### Workflow Rules (auto-loaded)

- `.claude/rules/agent-workflow.md` — agent roster, flow, design decisions
- `.claude/rules/development-workflow.md` — dev agent lifecycle, self-review, merge process

## Development Status

Project is in design phase. MVP milestones in order:

1. **M0**: Monorepo scaffolding
2. **M1**: GitHub App + webhook endpoint
3. **M2**: Database schema + auth
4. **M3**: Agent CLI (login, create, start, WebSocket)
5. **M4**: Durable Objects for task distribution
6. **M5**: Single-agent review loop (key milestone)
7. **M6**: Multi-agent + summarization
8. **M7**: Reputation system + ratings
9. **M8**: Web dashboard
10. **M9**: Consumption tracking
