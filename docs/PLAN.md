# OpenCara — Project Plan

## Overview

Distributed AI code review service. Contributors run review agents locally, the platform coordinates multi-agent reviews on GitHub PRs, and a reputation system ranks agents.

## Milestones

### M0: Project Scaffolding [DONE] — #1 → PR #2 (architect)

Monorepo with all packages buildable.

- [x] Initialize monorepo (pnpm workspaces) — 4 packages: shared, worker, cli, web
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

- [x] `opencara login` — device flow auth, saves API key to ~/.opencara/config.yml
- [x] `opencara agent create/list` — agent registration via REST API
- [x] `opencara agent start` — WebSocket connection with heartbeat
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

### M5: Single Agent Review Loop [DONE] — #13 → PR #17 (worker-dev), #14 → PR #16 (cli-dev)

One agent receives a task, reviews locally, result appears on GitHub. **Key milestone.**

- [x] CLI: AI-powered review execution (Anthropic Claude API) — PR #16
- [x] CLI: verdict extraction (approve/request_changes/comment) — PR #16
- [x] CLI: diff size guard + timeout awareness — PR #16
- [x] Shared protocol: add `diffContent` to `ReviewRequestMessage` — PR #17
- [x] Worker: fetch PR diff, include in review_request message — PR #17
- [x] Worker: post review as GitHub PR comment on review_complete — PR #17
- [x] Worker: store comment_url in review_results — PR #17
- [x] Worker: transition task reviewing → completed — PR #17
- [x] Worker: redistribute on rejection/error (up to 3 attempts, then failed) — PR #17
- [x] E2E: PR webhook → task → agent reviews → comment on GitHub — QA PASSED (294 tests, S01-S23)

### M6: Multi-Agent + Summarization [DONE] — #19 → PR #23 (worker-dev), #20 → PR #22 (cli-dev)

Multiple agents review in parallel with consolidated summary.

- [x] Shared protocol: update `SummaryRequestMessage` with full payload (pr, project, reviews[], timeout) — PR #23
- [x] Worker: dispatch to ALL eligible agents (not just min_count) — PR #23
- [x] Worker: collect reviews — no immediate GitHub post when min_count > 1 — PR #23
- [x] Worker: trigger summarization when min_count completed results arrive — PR #23
- [x] Worker: select highest-reputation agent for summarization — PR #23
- [x] Worker: post summary as main PR comment, individual reviews as follow-ups — PR #23
- [x] Worker: fallback to individual review posts if summary fails — PR #23
- [x] Worker: timeout with partial results triggers summarization — PR #23
- [x] Single-agent mode (min_count=1) preserves M5 behavior exactly — PR #23
- [x] CLI: summary execution engine (AI synthesis of multiple reviews) — PR #22
- [x] CLI: `summary_complete` with consolidated summary + tokensUsed — PR #22

### M7: Reputation System [DONE] — #25 → PR #29 (worker-dev)

Maintainers rate reviews via emoji reactions, agent and user reputation updates via Wilson scoring.

- [x] Rating collection via GitHub Reactions API (fetchCommentReactions with pagination)
- [x] Rating logic (thumbsup +1, thumbsdown -1, deduplicate by rater, upsert)
- [x] Wilson confidence interval scoring (agent-level and user-level)
- [x] Reputation history tracking (score deltas with reasons)
- [x] `GET /api/stats/:agentId` — reputation + review stats (authenticated, ownership-verified)
- [x] `GET /api/leaderboard` — top 50 agents by Wilson score (public)
- [x] `POST /api/tasks/:taskId/collect-ratings` — manual trigger for rating collection
- [x] Fixed duplicate SummaryReview interface (#24)
- [x] Shared types: AgentStatsResponse, LeaderboardResponse, LeaderboardEntry, CollectRatingsResponse
- [x] 447 tests, 100% coverage on new files

### M8: Web Dashboard [DONE] — #31,#32 → PR #37 (web-dev), #33 → PR #36 (worker-dev), #34 → PR #39 (web-dev)

Public leaderboard, personal stats dashboard, and GitHub OAuth web flow.

- [x] #31 [web-dev] Landing page + Tailwind CSS setup + shared layout (nav, footer) — PR #37
- [x] #32 [web-dev] Leaderboard page — public agent rankings — PR #37
- [x] #33 [worker-dev] Web OAuth callback endpoint (`GET /auth/login`, `/auth/callback`, `/auth/logout`, CORS) — PR #36
- [x] #34 [web-dev] Dashboard page — authenticated personal stats + consumption — PR #39
- [x] 511+ tests after M8, 92% overall coverage, 100% on M8 files

### M9: Consumption Tracking [DONE] — #26 → PR #28 (worker-dev), #27 → PR #30 (cli-dev)

Contributors can track and limit token consumption.

- [x] Worker: `GET /api/consumption/:agentId` — aggregated consumption stats (total, 24h, 7d, 30d) — PR #28
- [x] Shared: `ConsumptionPeriodStats` and `ConsumptionStatsResponse` types — PR #28
- [x] CLI: `opencara stats` command — display consumption for all/specific agents — PR #30
- [x] CLI: Local consumption limits in `~/.opencara/config.yml` — PR #30
- [x] CLI: Limit enforcement before review execution (reject with `consumption_limit_exceeded`) — PR #30
- [x] CLI: Post-review consumption notification in console — PR #30
- [x] Graceful degradation when consumption API unavailable — PR #30

## MVP Complete

All 10 milestones (M0-M9) are DONE. The MVP acceptance criteria are met:

1. A maintainer can install the GitHub App and have PRs automatically reviewed
2. A contributor can run `opencara login && opencara agent create && opencara agent start` and begin reviewing
3. Multiple agents review a PR in parallel with a consolidated summary
4. Maintainers can rate reviews with emoji, affecting agent reputation
5. A web dashboard shows leaderboard and personal stats
6. Contributors can track and limit their token consumption

## Post-MVP

- #40 [architect, DONE] Database Schema Migration + Environment Setup — PR #42 merged
- #41 [web-dev, DONE] Fix dashboard quality issues (hydration, errors, AbortController, coverage) — PR #44 merged
- #43 [worker-dev, DONE] Fix CORS origin validation + add security headers — PR #45 merged
- #47 [cli-dev, DONE] Refactor CLI to invoke local tools instead of Anthropic API — PR #49 merged
- #48 [worker-dev, DONE] Distribute pending tasks when agent comes online — PR #50 merged
- #51 [worker-dev, DONE] Fix WebSocket disconnect on authentication — PR #52 merged
- #53 [worker-dev, DONE] Fix WebSocket reconnect loop — stale close guard + code 4002 — PR #54 merged
- #55 [worker-dev, DONE] Fix WebSocket re-entrance: debounce + skip pickup on reconnect — PR #56 merged
- #57 [worker-dev, DONE] E2E review loop fix — default config, reconnect pickup, diagnostics — PR #59 merged
- #58 [architect, DONE] Migrate from npm to pnpm with global virtual store — PR #60 merged
- #61 [cli-dev, DONE] CLI WebSocket disconnects — diagnostics + reconnect stability — PR #68 merged
- #62 [cli-dev, DONE] Tool executor stdin delivery + stderr capture — PR #68 merged
- #63 [cli-dev, DONE] Configurable agent tool command via template string — PR #76 merged
- #64 [breakdown, DONE] Dashboard redesign: CLI-first personal stats + public web project stats
  - #69 [architect, DONE] Shared types: remove leaderboard, add trust tier + project stats — PR #74 merged
  - #70 [worker-dev, DONE] Worker: project stats API + trust tier — PR #75 merged
  - #71 [web-dev, DONE] Web: landing + public community page, no auth — PR #77 merged
  - #72 [cli-dev, DONE] CLI: enrich stats with trust tier + quality — PR #78 merged
- #73 [cli-dev, DONE] Configurable stability threshold for agent start — PR #79 merged
- #82 [worker-dev, DONE] Use GitHub PR Review API instead of issue comments — PR #93 merged
- #83 [worker-dev, DONE] Always synthesize reviews, even in single-agent mode — PR #93 merged
- #84 [worker-dev, DONE] Add preferred_models support to .review.yml — PR #104 merged
- #85 [cli-dev, DONE] Add --all flag to start all agents concurrently — PR #109 merged
- #86 [cli-dev, DONE] Local-config-driven agent management — PR #89 merged
- #87 [cli-dev, DONE] Fix token counting + per-agent limits — PR #94 merged
- #88 [worker-dev, DONE] Post timeout comment on PR + /review retry — PR #108 merged
- #91 [direct, DONE] Rebrand OpenCrust → OpenCara — PR #91 merged
- #92 [direct, DONE] Post-rebrand fixes: template interpolation + CLI auth — PR #92 merged
- #95 [worker-dev, DONE] Use accurate reviewCount, pick exact reviewer count — PR #97 merged
- #96 [worker-dev, DONE] Single-agent PR Review API with inline comments — PR #97 merged
- #99 [worker-dev, DONE] Add trigger control for reviews — PR #103 merged
- #100 [worker-dev, DONE] Don't store diff_content in database — PR #107 merged
- #101 [worker-dev, DONE] Show contributor GitHub profile in reviews — PR #106 merged
- #102 [cli-dev, DONE] Fix periodic WebSocket disconnect (code=1006) — PR #105 merged
- #110 [direct, DONE] E2E test suite + multi-agent review redesign with synthesizer — PR #110 merged

## Backlog

- #35 [worker-dev, DONE] Optimize leaderboard endpoint — resolved by PR #75 (endpoint removed)
- #38 [worker-dev, priority:low] Implement installation event handlers — project upsert and cleanup
- #80 [cli-dev, priority:low] Add growth trends to opencrust stats
- #81 [cli-dev, priority:low] Add expertise areas to opencrust stats
- #90 [worker-dev, priority:low] Dynamic tool/model registry — admin API + database storage
- #111 [worker-dev, DONE] Evenly distribute review tasks across agents (load balancing) — PR #117 merged
- #112 [breakdown] Allow agents to configure target repos for review
  - #113 [architect, DONE] Shared types: repo config + protocol extension — PR #116 merged
  - #114 [worker-dev, IN PROGRESS] Filter agents by repo preferences
  - #115 [cli-dev, blocked by #114] Parse and send repo config preferences

## Dependency Graph

```
M0 → M1 → M4 → M5 → M6
M0 → M2 → M3 → M5 → M7 → M8
M0 → M2 → M4       M5 → M9
```

## Merged PRs

| PR   | Issue  | Agent      | Date       | Description                                                     |
| ---- | ------ | ---------- | ---------- | --------------------------------------------------------------- |
| #2   | #1     | architect  | 2026-03-16 | M0 Project Scaffolding — Monorepo Setup                         |
| #6   | #5     | worker-dev | 2026-03-16 | M2 Database Schema + Auth Endpoints                             |
| #7   | #4     | worker-dev | 2026-03-16 | M1 GitHub App + Webhook Endpoint                                |
| #10  | #8     | cli-dev    | 2026-03-16 | M3 Agent CLI — Login, Agent Management, WebSocket               |
| #12  | #9     | worker-dev | 2026-03-16 | M4 Durable Objects — Agent WebSocket & Task Distribution        |
| #15  | #11    | architect  | 2026-03-16 | Test coverage to near 100% (245 tests, 100% statement coverage) |
| #16  | #14    | cli-dev    | 2026-03-16 | M5-C CLI AI-powered review execution engine                     |
| #17  | #13    | worker-dev | 2026-03-16 | M5-W Review result posting, task lifecycle & redistribution     |
| #21  | #18    | architect  | 2026-03-16 | Fix pre-existing typecheck and formatting issues                |
| #22  | #20    | cli-dev    | 2026-03-16 | M6-C CLI Summary Execution Engine                               |
| #23  | #19    | worker-dev | 2026-03-16 | M6-W Multi-Agent Dispatch + Summarization Trigger               |
| #28  | #26    | worker-dev | 2026-03-16 | M9-W Consumption Stats API Endpoint                             |
| #29  | #25    | worker-dev | 2026-03-16 | M7 Reputation System — Wilson Scoring + Leaderboard             |
| #30  | #27    | cli-dev    | 2026-03-16 | M9-C CLI Stats Command + Local Consumption Limits               |
| #36  | #33    | worker-dev | 2026-03-16 | M8-WK Web OAuth Callback Endpoint                               |
| #37  | #31,32 | web-dev    | 2026-03-16 | M8 Landing Page, Layout, Leaderboard                            |
| #39  | #34    | web-dev    | 2026-03-16 | M8 Dashboard — Personal Stats + Consumption                     |
| #42  | #40    | architect  | 2026-03-16 | Deployment guide + rating uniqueness constraint                 |
| #44  | #41    | web-dev    | 2026-03-16 | Fix dashboard quality — hydration, errors, AbortController      |
| #45  | #43    | worker-dev | 2026-03-16 | Fix CORS origin validation + security headers                   |
| #49  | #47    | cli-dev    | 2026-03-16 | Refactor CLI to invoke local tools instead of Anthropic API     |
| #50  | #48    | worker-dev | 2026-03-16 | Distribute pending tasks when agent comes online                |
| #52  | #51    | worker-dev | 2026-03-16 | Fix WebSocket disconnect on authentication                      |
| #54  | #53    | worker-dev | 2026-03-16 | Fix WebSocket reconnect loop — stale close guard + code 4002    |
| #56  | #55    | worker-dev | 2026-03-16 | Fix WebSocket re-entrance: debounce + skip pickup on reconnect  |
| #59  | #57,46 | worker-dev | 2026-03-17 | Fix E2E review loop — default config, reconnect pickup          |
| #60  | #58    | architect  | 2026-03-17 | Migrate from npm to pnpm with global virtual store              |
| #68  | #61,62 | cli-dev    | 2026-03-17 | WebSocket diagnostics + tool executor stdin delivery            |
| #74  | #69    | architect  | 2026-03-17 | Remove leaderboard types, add trust tier + project stats        |
| #75  | #70,35 | worker-dev | 2026-03-17 | Replace leaderboard with project stats + trust tier API         |
| #76  | #63    | cli-dev    | 2026-03-17 | Configurable agent tool command via template strings            |
| #77  | #71    | web-dev    | 2026-03-17 | Strip to landing page + public community stats                  |
| #78  | #72    | cli-dev    | 2026-03-17 | Enrich opencrust stats with trust tier + review quality         |
| #79  | #73    | cli-dev    | 2026-03-17 | Configurable stability threshold for agent start                |
| #89  | #86    | cli-dev    | 2026-03-17 | Local-config-driven agent management                            |
| #91  | —      | direct     | 2026-03-17 | Rebrand OpenCrust → OpenCara                                    |
| #92  | —      | direct     | 2026-03-17 | Post-rebrand fixes: template interpolation + CLI auth           |
| #93  | #82,83 | direct     | 2026-03-17 | Use GitHub PR Review API + revised review pipeline              |
| #94  | #87    | direct     | 2026-03-17 | Fix token counting + per-agent limits                           |
| #97  | #95,96 | direct     | 2026-03-17 | reviewCount + inline PR review comments                         |
| #103 | #99    | direct     | 2026-03-17 | Add trigger control for reviews                                 |
| #104 | #84    | direct     | 2026-03-17 | Add preferred_models support to .review.yml                     |
| #105 | #102   | direct     | 2026-03-17 | RFC 6455 WebSocket ping frames to prevent disconnects           |
| #106 | #101   | direct     | 2026-03-17 | Show contributor GitHub profile in reviews                      |
| #107 | #100   | direct     | 2026-03-17 | Don't store diff_content in database — fetch on demand          |
| #108 | #88    | direct     | 2026-03-17 | Post timeout comment on PR when review times out                |
| #109 | #85    | direct     | 2026-03-17 | Add --all flag to start all agents concurrently                 |
| #110 | —      | direct     | 2026-03-18 | E2E test suite + multi-agent review redesign with synthesizer   |
