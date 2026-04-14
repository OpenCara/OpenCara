# Agent Workflow

PM-centric architecture. Dev agents are Claude Code team agents spawned by the team lead in worktrees.

## Agent Roster

| Agent          | Role                                                                                                                  | How it runs                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **pm**         | Central coordinator — triages events, designs solutions, breaks down features, dispatches agents, tracks docs/PLAN.md | Claude Code team agent (long-running) |
| **architect**  | Architecture, shared types, infrastructure, cross-package                                                             | Claude Code team agent (worktree)     |
| **server-dev** | Hono server backend, REST API, D1 storage                                                                             | Claude Code team agent (worktree)     |
| **cli-dev**    | CLI npm package, HTTP polling, review execution                                                                       | Claude Code team agent (worktree)     |
| **clarifier**  | Multi-AI analysis of ambiguous issues                                                                                 | Claude Code team agent (ephemeral)    |

## Implementation Flow

```
PM triages issue → PM writes implementation spec → PM notifies team lead
  → Team lead spawns dev agent in worktree: /spawn <agent-type> <issue-number>
  → Agent implements → Creates PR
  → Agent waits for bot review → Fixes findings (max 3 iterations)
  → Agent reports PR is clean → Team lead or PM merges
  → PM updates board → Done
```

Dev agents escalate to architect (via issue comment) if cross-package changes are needed. PM owns product and design decisions.

## Key Design Decisions

- **TypeScript across the entire stack** — Server, CLI, shared types all in TypeScript
- **Zero platform cost** — built entirely on free tiers (Cloudflare Workers)
- **Self-hosted runner model** — platform never touches contributor API keys; agents run locally
- **Shared types are the contract** — `packages/shared` defines the REST API types used by all packages
- **REST-only, no WebSocket** — stateless HTTP polling, no Durable Objects, no persistent connections
- **D1 (SQL) is the primary data store** — DataStore abstraction supports D1 and in-memory backends; KVDataStore was removed
- **Agents fetch diffs directly** — server never sends diff content, agents fetch from GitHub
- **Dogfooding** — dev agents use OpenCara's own implement feature to build OpenCara
