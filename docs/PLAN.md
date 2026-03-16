# OpenCrust — Project Plan

## Overview

Distributed AI code review service. Contributors run review agents locally, the platform coordinates multi-agent reviews on GitHub PRs, and a reputation system ranks agents.

## Milestones

### M0: Project Scaffolding [DONE] — #1 → PR #2 (architect)

Monorepo with all packages buildable.

- [x] Initialize monorepo (npm workspaces) — 4 packages: shared, worker, cli, web
- [x] TypeScript strict config with project references
- [x] ESLint 9 flat config + Prettier
- [x] Vitest workspace (5 tests passing)
- [x] GitHub Actions CI (lint + format + typecheck + build + test)

### M1: GitHub App + Webhook [DONE] — #4 → PR #7 (worker-dev)

Platform receives PR events from GitHub.

- [x] Webhook endpoint with HMAC-SHA256 signature validation
- [x] pull_request.opened/synchronize handling with .review.yml parsing
- [x] installation.created/deleted handling
- [x] ReviewConfig type, parser, validator in shared
- [x] GitHub API client (JWT auth, installation tokens, repo content, PR comments)
- [x] docs/github-app-setup.md
- [x] 35 new tests passing

### M2: Database + Auth [DONE] — #5 → PR #6 (worker-dev)

Users can register, agents can be created.

- [x] 9-table PostgreSQL migration with FK constraints and indexes
- [x] OAuth device flow endpoints (POST /auth/device, POST /auth/device/token)
- [x] API key revocation (POST /auth/revoke)
- [x] Agent CRUD (GET/POST /api/agents)
- [x] Auth middleware (SHA-256 API key hash validation)
- [x] Shared types (DB entities, API types, protocol types)
- [x] 39 unit tests passing

### M3: Agent CLI — Connect [DONE] — #8 → PR #10 (cli-dev)

CLI can authenticate and maintain a live connection to the platform.

- [x] `opencrust login` — device flow auth, saves API key to ~/.opencrust/config.yml
- [x] `opencrust agent create/list` — agent registration via REST API
- [x] `opencrust agent start` — WebSocket connection with heartbeat
- [x] Exponential backoff reconnect (1s-30s with jitter)
- [x] Graceful shutdown (SIGINT/SIGTERM)
- [x] 26 new tests (64 total passing)

### M4: Durable Objects — Task Distribution [DONE] — #9 → PR #12 (worker-dev)

Platform can push tasks to connected agents.

- [x] AgentConnection Durable Object (WebSocket management, heartbeat, message handling)
- [x] TaskTimeout Durable Object (alarm-based timeout, status transitions)
- [x] Task distribution (agent eligibility, whitelist/blacklist, FIFO selection)
- [x] Webhook integration (PR event → task creation → agent dispatch)
- [x] Shared protocol updated (full message envelope with id, timestamp, payload)
- [x] 92 new tests (156 total passing)

### M5: Single Agent Review Loop [NEXT]

One agent receives a task, reviews locally, result appears on GitHub. **Key milestone.**

### M6: Multi-Agent + Summarization [BLOCKED by M5]

Multiple agents review in parallel with consolidated summary.

### M7: Reputation System [BLOCKED by M5]

Maintainers rate reviews, agent reputation updates.

### M8: Web Dashboard [BLOCKED by M0, M7]

Public leaderboard and personal stats.

### M9: Consumption Tracking [BLOCKED by M5]

Contributors can track and limit token consumption.

## Dependency Graph

```
M0 → M1 → M4 → M5 → M6
M0 → M2 → M3 → M5 → M7 → M8
M0 → M2 → M4       M5 → M9
```

## Merged PRs

| PR | Issue | Agent | Date | Description |
|----|-------|-------|------|-------------|
| #2 | #1 | architect | 2026-03-16 | M0 Project Scaffolding — Monorepo Setup |
| #6 | #5 | worker-dev | 2026-03-16 | M2 Database Schema + Auth Endpoints |
| #7 | #4 | worker-dev | 2026-03-16 | M1 GitHub App + Webhook Endpoint |
| #10 | #8 | cli-dev | 2026-03-16 | M3 Agent CLI — Login, Agent Management, WebSocket |
| #12 | #9 | worker-dev | 2026-03-16 | M4 Durable Objects — Agent WebSocket & Task Distribution |
