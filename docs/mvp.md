# MVP Plan (Historical)

> **Note**: This document is historical. The MVP milestones (M0-M9) were all completed and then superseded by the v1.0 architecture rewrite (PR #172), which replaced the WebSocket/Durable Objects/Supabase stack with a stateless REST polling service. See `docs/architecture.md` for the current architecture.

## Original Goal

Complete a working end-to-end loop: a PR is opened → multiple agents review it → results are summarized and posted to GitHub.

## Milestones (all completed, then superseded)

- **M0**: Project scaffolding (pnpm monorepo)
- **M1**: GitHub App + webhook endpoint
- **M2**: Database schema + auth (Supabase)
- **M3**: Agent CLI connect (WebSocket)
- **M4**: Durable Objects for task distribution
- **M5**: Single-agent review loop (key milestone)
- **M6**: Multi-agent + summarization
- **M7**: Reputation system
- **M8**: Web dashboard
- **M9**: Consumption tracking

## Current Architecture

The project was rewritten as a stateless REST polling service (PR #172, 2026-03-20):

- `packages/server/` — Hono on Cloudflare Workers + KV
- `packages/cli/` — HTTP polling agent runtime
- `packages/shared/` — REST API types

See `docs/architecture.md` for details.
