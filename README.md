# OpenCara

Orchestration layer between AI agents and GitHub (extensible to other platforms).

OpenCara receives webhook events from GitHub, coordinates agents driven by those events, and writes results back to the platform.

Example flows:

- Issue moves from `backlog` → `ready` on a GitHub Projects v2 board → dispatch the implement agent (built-in template `issue-implement`).
- PR opened → start a reviewer agent → after review posted, ask the dev agent to address feedback (built-in template `pr-review`).

## Architecture

| Package | Purpose |
| --- | --- |
| `packages/shared` | Shared TS types and wire-protocol contracts. Published to npm as `@opencara/shared`. |
| `packages/flows` | Built-in flow definitions + Zod schemas for the orchestrator's DAG types. |
| `packages/orchestrator` | Hono server: webhook ingestion, event-driven agent dispatch, persistent state (Postgres + Drizzle). |
| `packages/cli` | Agent-host CLI. Daemon that registers a machine with the orchestrator and runs dispatched agent subprocesses. Published as [`opencara`](https://www.npmjs.com/package/opencara) (`npm i -g opencara` → `opencara` binary; runs the pair flow on first start, then accepts jobs). Think: GitHub Actions self-hosted runners. |
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
pnpm --filter @opencara/orchestrator db:migrate

# 3. Run all packages in watch mode
pnpm dev

# Other tasks
pnpm typecheck
pnpm build
```

Default local postgres: `postgres://opencara:opencara@localhost:5433/opencara`. Copy `.env.example` to `packages/orchestrator/.env` and fill in `GITHUB_WEBHOOK_SECRET`.

## GitHub App permissions and events

For the built-in flows to work end-to-end, the GitHub App needs:

- **Repository permissions:** `Issues: read & write`, `Pull requests: read & write`, `Metadata: read`, `Contents: read`.
- **Organization permissions:** `Projects: read` (required for the `issue-implement` flow to receive `projects_v2_item` events).
- **Subscribed events:** `Pull request`, `Issues`, `Projects v2 item`, `Installation`, `Installation repositories`.

The `Issues` and `Projects v2 item` subscriptions drive the Issues tab on the project page (issue rows are normalized from the webhook + a one-shot REST backfill on project add) and the `issue-implement` flow template (Projects v2 status changes).
