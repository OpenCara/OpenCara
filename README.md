# OpenKira

Orchestration layer between AI agents and GitHub (extensible to other platforms).

OpenKira receives webhook events from GitHub, coordinates agents driven by those events, and writes results back to the platform.

Example flows:

- Issue moves from `backlog` → `ready` → assign a dev agent to work on it.
- PR opened → start a reviewer agent → after review posted, ask the dev agent to address feedback.

## Architecture

| Package | Purpose |
| --- | --- |
| `packages/shared` | Shared TS types and wire-protocol contracts. |
| `packages/orchestrator` | Hono server: webhook ingestion, event-driven agent dispatch, persistent state (Postgres + Drizzle). |
| `packages/agent-host` | Daemon that registers with the orchestrator and runs agent subprocesses. Other machines can register as hosts (think: GitHub Actions self-hosted runners). |
| `apps/web` | React + React Flow UI for visualizing and editing orchestration flows. |

## Stack

- TypeScript end-to-end
- pnpm workspaces
- Hono (orchestrator API)
- PostgreSQL + Drizzle ORM
- Vite + React + React Flow (web UI)
- Node.js ≥ 22

## Development

```bash
pnpm install

# 1. Start postgres (port 5433, named volume)
podman-compose up -d        # or: docker compose up -d

# 2. Run migrations
pnpm --filter @openkira/orchestrator db:migrate

# 3. Run all packages in watch mode
pnpm dev

# Other tasks
pnpm typecheck
pnpm build
```

Default local postgres: `postgres://openkira:openkira@localhost:5433/openkira`. Copy `.env.example` to `packages/orchestrator/.env` and fill in `GITHUB_WEBHOOK_SECRET`.
