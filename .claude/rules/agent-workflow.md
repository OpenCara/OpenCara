# Agent Workflow

Event-driven, PM-centric architecture. Dev agents are implemented via OpenCara's own `[implement]` feature with named agents configured in `.opencara.toml`.

## Agent Roster

| Agent          | Role                                                                                                                  | How it runs                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **pm**         | Central coordinator — triages events, designs solutions, breaks down features, dispatches agents, tracks docs/PLAN.md | Claude Code team agent (long-running)             |
| **architect**  | Architecture, shared types, infrastructure, cross-package                                                             | OpenCara implement agent (`[[implement.agents]]`) |
| **server-dev** | Hono server backend, REST API, D1 storage                                                                             | OpenCara implement agent (`[[implement.agents]]`) |
| **cli-dev**    | CLI npm package, HTTP polling, review execution                                                                       | OpenCara implement agent (`[[implement.agents]]`) |
| **clarifier**  | Multi-AI analysis of ambiguous issues                                                                                 | Claude Code team agent (ephemeral)                |

## Implementation Flow

```
PM triages issue → PM sets "Agent" field on project board (e.g., "server-dev")
  → Team lead or PM moves issue to "In progress"
  → projects_v2_item.edited webhook fires
  → Server reads "Agent" field via agent_field config
  → Resolves agent config from [[implement.agents]]
  → Creates implement task with agent's prompt/model/tool
  → CLI agent claims and implements → Creates PR → STOPS
  → Bot reviews PR → PM comments /opencara fix → Fix agent resolves findings
  → PM checks if clean → Merges PR (max 3 fix iterations)
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
