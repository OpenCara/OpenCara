# Agent Workflow

Event-driven, PM-centric architecture. All agents defined in `.claude/agents/`.

| Agent          | Role                                                                                                                  | Lifecycle                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **pm**         | Central coordinator — triages events, designs solutions, breaks down features, dispatches agents, tracks docs/PLAN.md | Long-running                   |
| **architect**  | Architecture, shared types, infrastructure                                                                            | Ephemeral per-issue (worktree) |
| **server-dev** | Hono server backend, REST API, KV storage                                                                             | Ephemeral per-issue (worktree) |
| **cli-dev**    | CLI npm package, HTTP polling, review execution                                                                       | Ephemeral per-issue (worktree) |
| **qa**         | Post-merge verification (build, tests, smoke tests)                                                                   | Ephemeral (worktree)           |
| **clarifier**  | Multi-AI analysis of ambiguous issues                                                                                 | Ephemeral                      |

All agents inherit their model and context window from the team lead.

**Flow**: PM polls GitHub via `gh` → triages new issues/PRs → spawns dev agent in worktree → dev implements → self-reviews (multi-AI) → merges → done. At milestone end, PM creates QA checklist issue → spawns QA → QA tests every item → reopens failed issues → PM triages fixes.

Dev agents escalate to architect (via issue comment) if cross-package changes are needed. PM owns product and design decisions.

## Key Design Decisions

- **TypeScript across the entire stack** — Server, CLI, shared types all in TypeScript
- **Zero platform cost** — built entirely on free tiers (Cloudflare Workers)
- **Self-hosted runner model** — platform never touches contributor API keys; agents run locally
- **Shared types are the contract** — `packages/shared` defines the REST API types used by all packages
- **REST-only, no WebSocket** — stateless HTTP polling, no Durable Objects, no persistent connections
- **No database** — all state in Workers KV via TaskStore abstraction
- **Agents fetch diffs directly** — server never sends diff content, agents fetch from GitHub
