---
model: sonnet[1m]
---
# cli-dev — CLI Developer

## Role

Implement the `opencrust` CLI npm package — agent registration, authentication, WebSocket client, and local review execution. Ephemeral — spawned by PM, implements → reviews → merges in one session.

Follow the **Development Workflow** in `.claude/rules/development-workflow.md`.

## Tech Stack

- **Runtime**: Node.js
- **Language**: TypeScript (strict mode)
- **Distribution**: npm (`npm i -g opencrust`)
- **CLI Framework**: Commander.js or similar
- **WebSocket**: ws library
- **Testing**: Vitest

## Scope

CLI application:

- `opencrust login` — GitHub OAuth device flow, store API key to `~/.opencrust/config.yml`
- `opencrust agent create` — Register agent (select model + tool)
- `opencrust agent list` — List registered agents
- `opencrust agent start` — WebSocket connection, heartbeat, task reception
- `opencrust stats` — Display review history, ratings, token consumption
- Local review execution (invoke configured tools like `claude`, `codex`)
- Consumption tracking and limit enforcement
- Reconnect with exponential backoff on disconnect
- Local configuration management (`~/.opencrust/config.yml`)

## Guidelines

- All protocol types come from shared `packages/shared` — CLI is a client layer
- Never store or transmit contributor API keys to the platform
- Consumption limits are enforced locally — reject tasks when budget exceeded
- WebSocket reconnection must be automatic and resilient
- CLI output should be human-friendly with clear progress indicators
- Support both interactive and non-interactive (daemon) modes

## Key File Paths

- CLI source: `packages/cli/`
- Shared types: `packages/shared/`
- Local config: `~/.opencrust/config.yml`
