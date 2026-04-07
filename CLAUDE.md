# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenCara is a distributed AI code review service. Contributors run review agents locally (using their own API keys), the platform coordinates multi-agent reviews on GitHub PRs via stateless REST polling. No accounts — just webhook + D1/KV + agents.

## Tech Stack

- **Backend**: Hono server on Cloudflare Workers (TypeScript)
- **Storage**: Cloudflare D1 (SQL) via DataStore abstraction
- **CLI**: npm package (TypeScript) — HTTP polling agent runtime
- **Shared**: Pure TypeScript types — REST API contracts, review config
- **Monorepo**: pnpm workspaces

## Monorepo Structure

```
packages/
  server/    — Hono server (webhook receiver, REST task API, GitHub integration)
  cli/       — Agent CLI (HTTP polling, local review execution, router mode)
  shared/    — Shared types (REST API contracts, review config parser)
```

## Architecture

### Core Data Flow

```
GitHub PR Webhook → Server creates task in D1
  → Agent polls /api/tasks/poll → Claims task → Fetches diff from GitHub
  → Reviews locally using contributor's AI tool → Submits result
  → Server posts review to GitHub PR
```

### REST API (no WebSocket)

| Method | Path                    | Description                     |
| ------ | ----------------------- | ------------------------------- |
| POST   | `/webhook/github`       | Receive GitHub webhook          |
| POST   | `/api/tasks/poll`       | Agent polls for available tasks |
| POST   | `/api/tasks/:id/claim`  | Agent claims a task             |
| POST   | `/api/tasks/:id/result` | Agent submits review result     |
| POST   | `/api/tasks/:id/reject` | Agent rejects a task            |
| POST   | `/api/tasks/:id/error`  | Agent reports an error          |
| GET    | `/api/registry`         | Tool/model registry             |

### DataStore Abstraction

- **D1DataStore** — Cloudflare D1 / SQLite (production, preferred)
- **MemoryDataStore** — In-memory (dev/test)
- Interface: `packages/server/src/store/interface.ts`

### Key Types (packages/shared)

- `ReviewTask`, `TaskClaim` — core data types
- `PollRequest/Response`, `ClaimRequest/Response`, `ResultRequest/Response` — REST API contracts
- `OpenCaraConfig`, `ReviewSectionConfig`, `FeatureConfig` — `.opencara.toml` parsing
- `DEFAULT_REGISTRY` — tool/model registry with default reputations

### Self-Hosted Runner Model

- Platform never touches contributor API keys
- Agents run locally, fetch diffs directly from GitHub
- Agents execute reviews using their own AI tools (claude, codex, gemini, qwen)
- Platform only coordinates tasks and posts results to GitHub

## Design Documents

- `docs/architecture.md` — Technical architecture, REST API, DataStore
- `docs/product.md` — Product design, `.opencara.toml` config spec
- `docs/deployment.md` — Deployment guide (CF Workers + D1 + KV)
- `docs/agent-guide.md` — Agent setup and configuration guide
- `docs/github-app-setup.md` — GitHub App creation and permissions

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
cd packages/server && pnpm dev            # Local Worker dev server
cd packages/cli && pnpm dev               # CLI development mode
```

## Code Style

- TypeScript strict mode across all packages
- ESLint + Prettier for formatting
- Vitest for testing

## Agent Team

Event-driven, PM-centric workflow. Dev agents are implemented via OpenCara's own `[implement]` feature (dogfooding).

| Agent          | Role                                               | How it runs                                       |
| -------------- | -------------------------------------------------- | ------------------------------------------------- |
| **pm**         | Coordinator — triages, designs, dispatches, tracks | Claude Code team agent (`.claude/agents/pm.md`)   |
| **architect**  | Shared types, infrastructure, cross-package        | OpenCara implement agent (`[[implement.agents]]`) |
| **server-dev** | Hono server backend                                | OpenCara implement agent (`[[implement.agents]]`) |
| **cli-dev**    | CLI npm package                                    | OpenCara implement agent (`[[implement.agents]]`) |
| **clarifier**  | Multi-AI issue analysis                            | Claude Code team agent (ephemeral)                |

### Agent Rules

- Only one PM at a time; PM never implements code, only plans and dispatches
- PM dispatches by setting the "Agent" field on the project board and moving issue to "In progress"
- Moving to "In progress" triggers the implement feature via `projects_v2_item.edited` webhook
- After creating a PR, implement agents wait for OpenCara bot review and self-review
- Team name: `opencara-dev`

### Workflow Rules (auto-loaded)

- `.claude/rules/agent-workflow.md` — agent roster, flow, design decisions
- `.claude/rules/development-workflow.md` — dev agent lifecycle, self-review, merge process
