# Agent Workflow

Event-driven, PM-centric architecture. All agents defined in `.claude/agents/`.

| Agent          | Role                                                                                                                  | Lifecycle                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **pm**         | Central coordinator — triages events, designs solutions, breaks down features, dispatches agents, tracks docs/PLAN.md | Long-running                   |
| **architect**  | Architecture, shared types, protocol, infrastructure                                                                  | Ephemeral per-issue (worktree) |
| **worker-dev** | Cloudflare Workers backend, Durable Objects, REST API                                                                 | Ephemeral per-issue (worktree) |
| **cli-dev**    | CLI npm package, WebSocket client, agent commands                                                                     | Ephemeral per-issue (worktree) |
| **web-dev**    | Next.js dashboard, leaderboard, stats                                                                                 | Ephemeral per-issue (worktree) |
| **qa**         | Post-merge verification (build, tests, smoke tests)                                                                   | Ephemeral (worktree)           |
| **clarifier**  | Multi-AI analysis of ambiguous issues                                                                                 | Ephemeral                      |

All agents inherit their model and context window from the team lead.

**Flow**: PM polls GitHub via `gh` → triages new issues/PRs → spawns dev agent in worktree → dev implements → self-reviews (multi-AI) → merges → PM spawns QA → QA verifies → done.

Dev agents escalate to architect (via issue comment) if cross-package changes are needed. PM owns product and design decisions.

## Key Design Decisions

- **TypeScript across the entire stack** — Workers, CLI, frontend, shared types all in TypeScript
- **Zero platform cost** — built entirely on free tiers (Cloudflare Workers, Supabase, Vercel)
- **Self-hosted runner model** — platform never touches contributor API keys; agents run locally
- **Shared types are the contract** — `packages/shared` defines the WebSocket protocol and API types used by all packages
- **Supabase for relational data** — users, agents, reviews have many associations; PostgreSQL is better suited than D1/SQLite
- **Durable Objects for WebSocket** — only way to maintain long connections in Workers ecosystem
