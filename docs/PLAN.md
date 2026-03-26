# OpenCara — Project Plan

## Overview

Distributed AI code review service. Contributors run review agents locally, the platform coordinates multi-agent reviews on GitHub PRs via stateless REST polling.

## Architecture (v1.0 — PR #172)

Stateless REST-only service. No WebSocket, no Durable Objects.

| Package           | Stack                    | Purpose                         |
| ----------------- | ------------------------ | ------------------------------- |
| `packages/server` | Hono + CF Workers + D1   | Webhook receiver, task REST API |
| `packages/cli`    | Commander + HTTP polling | Agent runtime, review executor  |
| `packages/shared` | Pure TypeScript types    | REST API contracts, config      |

**Flow**: GitHub webhook → server creates task in D1 → agent polls `/api/tasks/poll` → claims → fetches diff from GitHub → reviews locally → submits result → server posts to GitHub

## MVP Milestones [ALL DONE — superseded by v1.0 rewrite]

<details>
<summary>Historical milestones (M0–M9)</summary>

### M0: Project Scaffolding — #1 -> PR #2

pnpm monorepo with 4 packages (shared, worker, cli, web). TypeScript strict mode, ESLint 9, Prettier, Vitest, GitHub Actions CI.

### M1: GitHub App + Webhook — #4 -> PR #7

Platform receives PR events. HMAC-SHA256 validation, .opencara.toml parsing, GitHub API client with JWT auth.

### M2: Database + Auth — #5 -> PR #6

PostgreSQL via Supabase. OAuth device flow, API key auth, agent CRUD. 7-table schema.

### M3: Agent CLI Connect — #8 -> PR #10

`opencara login/agent create/agent start`. WebSocket with heartbeat, exponential backoff reconnect, graceful shutdown.

### M4: Durable Objects — #9 -> PR #12

AgentConnection DO (WebSocket management), TaskTimeout DO (alarm-based timeout). Task distribution with eligibility filtering.

### M5: Single-Agent Review Loop — #13,#14 -> PR #16,#17

**Key milestone.** E2E: PR webhook -> task creation -> agent reviews locally -> result posted as GitHub comment. Redistribution on failure.

### M6: Multi-Agent + Summarization — #19,#20 -> PR #22,#23

Parallel dispatch to all eligible agents. Synthesizer consolidates reviews. Timeout fallback with partial results.

### M7: Reputation System — #25 -> PR #29

Emoji reactions drive ratings. Wilson confidence interval scoring at agent and user level. Reputation history tracking.

### M8: Web Dashboard — #31-34 -> PR #36,#37,#39

Landing page, public leaderboard, personal stats dashboard (later redesigned to CLI-first + community page).

### M9: Consumption Tracking — #26,#27 -> PR #28,#30

Server-side consumption stats API. CLI `opencara stats` command with local limits and enforcement.

</details>

## Post-MVP [DONE — superseded by v1.0 rewrite]

<details>
<summary>Historical post-MVP work (50+ items)</summary>

- **Stability**: WebSocket fixes (#51-57,#61,#62,#102), reconnect, ping frames
- **Review quality**: PR Review API (#82,#83,#96), inline comments (#136), synthesizer redesign (#110)
- **Configuration**: trigger control (#99), preferred_models (#84), tool commands (#63), stability threshold (#73)
- **Architecture**: pnpm migration (#58), schema simplification 9->7 tables (#121), dashboard redesign (#64)
- **Agent features**: local-config agents (#86), --all flag (#85), repo filtering (#112), anonymous agents (#123), agent details in reviews (#135)
- **Infrastructure**: deployment (#40), CORS/security (#43), npm publishing CI (#132,#140-143)
- **CLI**: local tools (#47), token counting (#87), stats enrichment (#72), contributor profiles (#101)
- **Rebrand**: OpenCrust -> OpenCara (#91,#92)

</details>

## v1.0 Rewrite (PR #172)

Complete rewrite to stateless REST polling. Dropped WebSocket, Durable Objects, Supabase, auth, reputation, ratings, leaderboard, web dashboard. 307 tests passing.

## M10: Hardening [DONE — 2026-03-20]

5 high-priority hardening issues completed:

| PR   | Issue | Agent      | Description                                     |
| ---- | ----- | ---------- | ----------------------------------------------- |
| #186 | #175  | server-dev | Reject/error free claim slots + state machine   |
| #187 | #176  | cli-dev    | Retry logic and error recovery in agent loop    |
| #188 | #173  | server-dev | KV hardening: safe JSON parse + TTL on terminal |
| #189 | #174  | server-dev | GitHub API retry logic                          |
| #190 | #182  | server-dev | Webhook idempotency via PR identity dedup       |

## M11: Code Review Audit [DONE — 2026-03-22]

15 issues from external code review audit (4 reports analyzed, deduplicated, validated).

### High Priority [ALL DONE]

| Issue | Agent      | PR   | Description                                             |
| ----- | ---------- | ---- | ------------------------------------------------------- |
| #228  | server-dev | #243 | Security: .opencara.toml read from PR head branch       |
| #229  | server-dev | #247 | KV store race conditions: eliminate shared task index   |
| #230  | server-dev | #244 | Reviewer/summarizer whitelist: user field not enforced  |
| #231  | server-dev | #246 | Repo filtering parsed but not enforced in poll endpoint |

### Medium Priority

| Issue | Agent      | Description                                  |
| ----- | ---------- | -------------------------------------------- |
| #232  | server-dev | Timeout check relies on isolate memory       |
| #233  | cli-dev    | Retry jitter missing (thundering herd)       |
| #234  | server-dev | No rate limiting on API endpoints            |
| #235  | cli-dev    | AbortSignal not passed to fetch in fetchDiff |
| #236  | cli-dev    | api_key config never passed to ApiClient     |
| #237  | cli-dev    | Consumption limits parsed but never enforced |
| #238  | cli-dev    | Token sanitization incomplete                |

### Low Priority

| Issue | Agent      | Description                                     |
| ----- | ---------- | ----------------------------------------------- |
| #239  | server-dev | Add health check and metrics endpoint           |
| #240  | server-dev | Dead config fields: autoApprove, minReputation  |
| #241  | server-dev | KV listTasks O(n) performance                   |
| #242  | server-dev | Installation token not refreshed for long tasks |

## M12: Operational Maturity & DX [DONE — 2026-03-22]

12 issues covering private repo support, developer experience, observability, and test coverage.

### High Priority [ALL DONE]

| Issue | Agent             | PR   | Description                                          |
| ----- | ----------------- | ---- | ---------------------------------------------------- |
| #282  | server-dev+shared | #292 | Private repo task isolation — filter at poll time    |
| #291  | cli-dev           | #293 | Include PR metadata and discussion context in review |

### Medium Priority [ALL DONE]

| Issue | Agent      | PR   | Description                                      |
| ----- | ---------- | ---- | ------------------------------------------------ |
| #280  | cli-dev    | #281 | Always set repo-scoped working directory         |
| #283  | server-dev | #295 | Structured error responses with error codes      |
| #284  | cli-dev    | #294 | Config validation with actionable error messages |
| #285  | server-dev | #297 | Task TTL and automatic cleanup of stale tasks    |
| #288  | cli-dev    | #296 | npm publish readiness: package.json, README, bin |
| #289  | server-dev | #298 | Structured logging with request IDs              |
| #290  | server-dev | #299 | E2E integration tests with mock GitHub API       |

### Low Priority [ALL DONE]

| Issue | Agent   | PR     | Description                                    |
| ----- | ------- | ------ | ---------------------------------------------- |
| #286  | cli-dev | #300   | CLI UX: progress indicators and colored output |
| #287  | pm      | direct | Docs refresh for v1.0+ features                |

### Done (early — before M12 started)

| Issue | Agent   | PR   | Description                     |
| ----- | ------- | ---- | ------------------------------- |
| #277  | cli-dev | #279 | Log the actual command executed |
| #278  | cli-dev | #279 | Log PR URL instead of diff URL  |

## M13: D1 Database Layer [DONE — 2026-03-22]

Introduced D1 (Cloudflare SQL) as the persistent data store, replacing KV-only storage for task coordination. Abstract DataStore interface enables KV, D1, or in-memory backends.

| Issue | Agent      | PR        | Description                                           |
| ----- | ---------- | --------- | ----------------------------------------------------- |
| #307  | architect  | #310      | Define DataStore interface + MemoryDataStore          |
| #308  | server-dev | #311,#314 | Integrate DataStore into server routes                |
| #309  | architect  | #312      | D1DataStore implementation + migration SQL + wrangler |

### Post-M13 Fixes

| PR   | Issue | Agent   | Description                                     |
| ---- | ----- | ------- | ----------------------------------------------- |
| #306 | #302  | cli-dev | Save agent logs to file for debugging           |
| #320 | #318  | direct  | Fix test suite hanging — resolve leaked handles |
| #322 | --    | direct  | CI baseline test at last green commit           |
| #324 | --    | direct  | Fix: allow mode:all agents to see private tasks |

## M14: Agent Identity & Role Configuration [DONE — 2026-03-23]

GitHub-backed agent identity for synthesizer access control, plus role-based agent configuration.

| Issue | Agent      | PR   | Description                                                        |
| ----- | ---------- | ---- | ------------------------------------------------------------------ |
| #326  | architect  | #329 | Add GitHub identity and role fields to API types [DONE]            |
| #327  | server-dev | #337 | Enforce GitHub identity in synthesizer eligibility [DONE]          |
| #328  | cli-dev    | #338 | Add synthesizer_only config and send identity in poll/claim [DONE] |

Dependency: #326 → (#327 + #328 in parallel)

### Related Fixes (2026-03-23)

| Issue | Agent      | PR   | Description                                                    |
| ----- | ---------- | ---- | -------------------------------------------------------------- |
| #316  | cli-dev    | #319 | Fix abort listener leak in sleep() [DONE]                      |
| #330  | server-dev | #334 | Bug: reviewer agents cannot claim summary role [DONE]          |
| #331  | server-dev | #334 | Refactor task claim flow to queue-based model [DONE]           |
| #333  | server-dev | #335 | Extract GitHubService interface for dev/prod [DONE]            |
| #317  | architect  | #317 | VPS self-hosting support [DONE]                                |
| #332  | server-dev | #340 | Consolidate timeout partial reviews into single comment [DONE] |
| #336  | cli-dev    | #339 | Fix tsc --build overwriting CLI tsup output [DONE]             |

## M15: Production Readiness [DONE — 2026-03-23]

Security hardening, correctness fixes, and observability improvements identified by multi-agent codebase analysis (Codex, GLM-5, Kimi-K2.5, Qwen3.5-Plus) and PM review.

### High Priority (security + correctness) [ALL DONE]

| Issue | Agent      | PR   | Description                                              |
| ----- | ---------- | ---- | -------------------------------------------------------- |
| #343  | server-dev | #364 | API key authentication for task endpoints                |
| #344  | server-dev | #366 | Runtime request validation with Zod schemas              |
| #345  | server-dev | #363 | Atomic review-slot counting to prevent oversubscription  |
| #346  | server-dev | #359 | Enforce `allow_anonymous: false` in reviewer eligibility |

### Medium Priority (resilience + observability)

| Issue | Agent      | PR   | Description                                                         |
| ----- | ---------- | ---- | ------------------------------------------------------------------- |
| #350  | cli-dev    | #358 | SIGKILL escalation after SIGTERM timeout [DONE]                     |
| #352  | server-dev | #361 | Add composite DB index for webhook dedup query [DONE]               |
| #355  | server-dev | #362 | Enforce preferred_models/preferred_tools in task polling [DONE]     |
| #356  | server-dev | #365 | Delete task and claims immediately after review posted [DONE]       |
| #357  | server-dev | #360 | Remove KVDataStore and Workers KV fallback [DONE]                   |
| #351  | cli-dev    | #375 | Streaming diff size guard to prevent OOM on large diffs [DONE]      |
| #347  | server-dev | --   | Heartbeat-based claim expiry and lock TTL [BACKLOG]                 |
| #348  | server-dev | --   | Webhook event log for delivery visibility [BACKLOG]                 |
| #349  | server-dev | --   | Agent activity endpoint with heartbeats and claim history [BACKLOG] |

### Bug Fixes [ALL DONE]

| Issue | Agent      | PR   | Description                                                   |
| ----- | ---------- | ---- | ------------------------------------------------------------- |
| #367  | server-dev | #369 | Fix CLAIM_CONFLICT spam: filter already-claimed summary tasks |
| #370  | server-dev | #371 | Fix late review results overwriting summary queue state       |

### New Features

| Issue | Agent   | PR   | Description                                                          |
| ----- | ------- | ---- | -------------------------------------------------------------------- |
| #368  | cli-dev | #374 | Display contributor GitHub profile link in review report [DONE]      |
| #373  | cli-dev | #376 | Per-day review cap, token budget, and accurate token tracking [DONE] |

### Low Priority (operational)

| Issue | Agent     | Description                                             |
| ----- | --------- | ------------------------------------------------------- |
| #353  | architect | Production deploy CI workflow — CLOSED (already exists) |
| #354  | cli-dev   | Add `opencara status` command for diagnostics [BACKLOG] |
| #302  | cli-dev   | Save agent logs to file for debugging [BACKLOG]         |

## M17: GitHub App OAuth Authentication [DONE — 2026-03-25]

Replace anonymous/self-reported agent identity with GitHub App OAuth (Device Flow). Single token for server auth + GitHub API access. No more `gh` CLI dependency.

Parent issue: #445

### Phase 1: Shared Types [DONE]

| Issue | Agent     | PR   | Description                                                |
| ----- | --------- | ---- | ---------------------------------------------------------- |
| #446  | architect | #454 | Add OAuth auth types, remove self-reported github_username |

### Phase 2: Server [DONE]

| Issue | Agent      | PR   | Description                                               |
| ----- | ---------- | ---- | --------------------------------------------------------- |
| #447  | server-dev | #456 | OAuth token verification middleware with D1 caching       |
| #448  | server-dev | #459 | Derive agent identity from verified OAuth token in routes |
| #449  | server-dev | #457 | Add OAuth Device Flow proxy endpoints                     |

### Phase 3: CLI [DONE]

| Issue | Agent   | PR   | Description                                                       |
| ----- | ------- | ---- | ----------------------------------------------------------------- |
| #450  | cli-dev | #455 | OAuth Device Flow auth module with token storage and refresh      |
| #451  | cli-dev | #458 | Add opencara auth login/status/logout commands                    |
| #452  | cli-dev | #460 | Replace github-auth.ts with OAuth token for diff fetch + API auth |

### Phase 4: Configuration & Docs [DONE]

| Issue | Agent | PR     | Description                                      |
| ----- | ----- | ------ | ------------------------------------------------ |
| #453  | pm    | direct | GitHub App OAuth configuration and documentation |

## Open Issues

- #348 [server-dev, medium, Backlog] Webhook event log for delivery visibility
- #302 [cli-dev, medium, Backlog] Save agent logs to file for debugging

## Merged PRs

| PR   | Issue  | Agent      | Date  | Description                      |
| ---- | ------ | ---------- | ----- | -------------------------------- |
| #2   | #1     | architect  | 03-16 | M0 Monorepo setup                |
| #6   | #5     | worker-dev | 03-16 | M2 DB schema + auth              |
| #7   | #4     | worker-dev | 03-16 | M1 Webhook endpoint              |
| #10  | #8     | cli-dev    | 03-16 | M3 CLI connect                   |
| #12  | #9     | worker-dev | 03-16 | M4 Durable Objects               |
| #15  | #11    | architect  | 03-16 | Test coverage 100%               |
| #16  | #14    | cli-dev    | 03-16 | M5 CLI review engine             |
| #17  | #13    | worker-dev | 03-16 | M5 Worker review posting         |
| #21  | #18    | architect  | 03-16 | Fix typecheck/format             |
| #22  | #20    | cli-dev    | 03-16 | M6 CLI summary engine            |
| #23  | #19    | worker-dev | 03-16 | M6 Multi-agent dispatch          |
| #28  | #26    | worker-dev | 03-16 | M9 Consumption API               |
| #29  | #25    | worker-dev | 03-16 | M7 Reputation system             |
| #30  | #27    | cli-dev    | 03-16 | M9 CLI stats                     |
| #36  | #33    | worker-dev | 03-16 | M8 OAuth callback                |
| #37  | #31,32 | web-dev    | 03-16 | M8 Landing + leaderboard         |
| #39  | #34    | web-dev    | 03-16 | M8 Dashboard                     |
| #42  | #40    | architect  | 03-16 | Deployment guide                 |
| #44  | #41    | web-dev    | 03-16 | Dashboard fixes                  |
| #45  | #43    | worker-dev | 03-16 | CORS + security                  |
| #49  | #47    | cli-dev    | 03-16 | Local tools refactor             |
| #50  | #48    | worker-dev | 03-16 | Pending task pickup              |
| #52  | #51    | worker-dev | 03-16 | WS auth disconnect fix           |
| #54  | #53    | worker-dev | 03-16 | WS reconnect loop fix            |
| #56  | #55    | worker-dev | 03-16 | WS re-entrance fix               |
| #59  | #57,46 | worker-dev | 03-17 | E2E review loop fix              |
| #60  | #58    | architect  | 03-17 | pnpm migration                   |
| #68  | #61,62 | cli-dev    | 03-17 | WS diagnostics + tool fix        |
| #74  | #69    | architect  | 03-17 | Trust tier types                 |
| #75  | #70,35 | worker-dev | 03-17 | Project stats API                |
| #76  | #63    | cli-dev    | 03-17 | Tool command templates           |
| #77  | #71    | web-dev    | 03-17 | Web community page               |
| #78  | #72    | cli-dev    | 03-17 | Stats enrichment                 |
| #79  | #73    | cli-dev    | 03-17 | Stability threshold              |
| #89  | #86    | cli-dev    | 03-17 | Local-config agents              |
| #91  | --     | direct     | 03-17 | Rebrand to OpenCara              |
| #92  | --     | direct     | 03-17 | Post-rebrand fixes               |
| #93  | #82,83 | direct     | 03-17 | PR Review API                    |
| #94  | #87    | direct     | 03-17 | Token counting fix               |
| #97  | #95,96 | direct     | 03-17 | Inline PR review comments        |
| #103 | #99    | direct     | 03-17 | Trigger control                  |
| #104 | #84    | direct     | 03-17 | preferred_models                 |
| #105 | #102   | direct     | 03-17 | WebSocket ping frames            |
| #106 | #101   | direct     | 03-17 | Contributor profiles             |
| #107 | #100   | direct     | 03-17 | Drop diff_content storage        |
| #108 | #88    | direct     | 03-17 | Timeout comment + retry          |
| #109 | #85    | direct     | 03-17 | --all agent start                |
| #110 | --     | direct     | 03-18 | E2E tests + synthesizer          |
| #116 | #113   | architect  | 03-18 | Repo config types                |
| #117 | #111   | worker-dev | 03-18 | Load balancing                   |
| #118 | #114   | worker-dev | 03-18 | Repo filtering                   |
| #119 | #115   | cli-dev    | 03-18 | Repo config CLI                  |
| #122 | #121   | architect  | 03-18 | Schema simplification            |
| #127 | #124   | architect  | 03-18 | Anonymous agent types            |
| #128 | #125   | worker-dev | 03-18 | Anonymous registration           |
| #134 | #126   | cli-dev    | 03-18 | Anonymous CLI support            |
| #137 | #136   | worker-dev | 03-18 | Synthesizer inline comments      |
| #138 | #132   | architect  | 03-18 | npm publish CI                   |
| #139 | #135   | worker-dev | 03-18 | Agent details in reviews         |
| #140 | --     | direct     | 03-18 | OIDC npm publishing              |
| #141 | --     | direct     | 03-18 | Test publish pipeline            |
| #142 | --     | direct     | 03-18 | npm publish with token           |
| #143 | --     | direct     | 03-18 | Test OIDC publishing             |
| #149 | #145   | architect  | 03-18 | Agent displayName types          |
| #150 | #131   | worker-dev | 03-18 | Default model reputation         |
| #151 | #147   | cli-dev    | 03-18 | Parse custom agent names         |
| #152 | #146   | worker-dev | 03-18 | Persist agent names              |
| #153 | --     | direct     | 03-18 | Fix tsc/tsup build conflict      |
| #158 | --     | direct     | 03-19 | Agent name display fixes         |
| #161 | --     | direct     | 03-19 | Prefix CLI logs w/ name          |
| #163 | #160   | worker-dev | 03-19 | Synthesizer retry on fail        |
| #168 | #167   | cli-dev    | 03-19 | Stdin-based agent commands       |
| #169 | #166   | cli-dev    | 03-19 | Router mode stdin/stdout         |
| #171 | --     | direct     | 03-19 | Plain text router + guide        |
| #172 | --     | direct     | 03-20 | Stateless REST polling           |
| #186 | #175   | server-dev | 03-20 | Claim slot freeing               |
| #187 | #176   | cli-dev    | 03-20 | CLI retry + error recovery       |
| #188 | #173   | server-dev | 03-20 | KV hardening                     |
| #189 | #174   | server-dev | 03-20 | GitHub API retry                 |
| #190 | #182   | server-dev | 03-20 | Webhook idempotency              |
| #191 | #185   | server-dev | 03-20 | Role validation on results       |
| #192 | #177   | cli-dev    | 03-20 | Model/tool info in claims        |
| #193 | #178   | cli-dev    | 03-20 | RouterRelay error handling       |
| #194 | #184   | server-dev | 03-20 | Optimize timeouts + app          |
| #195 | #165   | cli-dev    | 03-20 | review_only config               |
| #196 | --     | direct     | 03-20 | E2E test suite                   |
| #197 | #164   | server-dev | 03-20 | Structured error logging         |
| #198 | --     | direct     | 03-20 | CLI E2E test suite               |
| #199 | #179   | server-dev | 03-20 | Review-parser robustness         |
| #200 | #180   | cli-dev    | 03-20 | Dead code cleanup                |
| #202 | #201   | qa         | 03-20 | Verdict case fix (qa)            |
| #203 | #201   | server-dev | 03-20 | Verdict case fix (server)        |
| #204 | --     | direct     | 03-20 | github_token for private repos   |
| #205 | --     | direct     | 03-21 | --all flag for agent start       |
| #206 | #130   | direct     | 03-21 | Clickable PR links in logs       |
| #207 | #156   | architect  | 03-21 | CI/CD auto-deploy dev worker     |
| #208 | --     | cli-dev    | 03-21 | Agent name prefix in CLI logs    |
| #209 | --     | cli-dev    | 03-21 | Startup dry-run test command     |
| #214 | #213   | server-dev | 03-21 | Whitelist/blacklist enforcement  |
| #215 | #212   | cli-dev    | 03-21 | Unified GitHub auth fallback     |
| #218 | #217   | server-dev | 03-21 | Switch to issue comments         |
| #219 | #210   | cli-dev    | 03-21 | Codebase clone for review        |
| #220 | #210   | cli-dev    | 03-21 | cwd instead of CODEBASE_DIR      |
| #222 | #221   | server-dev | 03-21 | Fix duplicate summary claims     |
| #223 | #211   | cli-dev    | 03-21 | Dockerfile + docker-compose      |
| #224 | #216   | server-dev | 03-21 | Preferred synthesizer config     |
| #226 | #225   | cli-dev    | 03-21 | Fix Docker build: copy tsconfig  |
| #243 | #228   | server-dev | 03-22 | .opencara.toml config security   |
| #244 | #230   | server-dev | 03-22 | Whitelist user enforcement       |
| #246 | #231   | server-dev | 03-22 | Repo filter enforcement          |
| #247 | #229   | server-dev | 03-22 | KV race conditions fix           |
| #249 | #235   | cli-dev    | 03-22 | AbortSignal in fetchDiff         |
| #250 | #233   | cli-dev    | 03-22 | Retry jitter                     |
| #251 | #236   | cli-dev    | 03-22 | api_key passed to ApiClient      |
| #252 | #237   | cli-dev    | 03-22 | Consumption limits enforcement   |
| #253 | #245   | cli-dev    | 03-22 | Auto-shutdown on errors          |
| #255 | #238   | cli-dev    | 03-22 | Token sanitization complete      |
| #258 | #254   | server-dev | 03-22 | KV read-after-write fix          |
| #260 | #232   | server-dev | 03-22 | Persist timeout in KV + cron     |
| #261 | #257   | cli-dev    | 03-22 | Test coverage to 97%             |
| #263 | #234   | server-dev | 03-22 | Rate limiting                    |
| #264 | #256   | server-dev | 03-22 | Task ID codebase isolation       |
| #266 | #265   | cli-dev    | 03-22 | Fix test regression              |
| #267 | #240   | server-dev | 03-22 | Remove dead config fields        |
| #268 | #239   | server-dev | 03-22 | Health + metrics endpoints       |
| #270 | #269   | cli-dev    | 03-22 | Env var override                 |
| #274 | #273   | server-dev | 03-22 | Duplicate summary fix            |
| #275 | #273   | server-dev | 03-22 | Race condition tests             |
| #279 | #277,8 | cli-dev    | 03-22 | Log command + PR URL             |
| #281 | #280   | cli-dev    | 03-22 | Repo-scoped cwd                  |
| #292 | #282   | server-dev | 03-22 | Private repo task isolation      |
| #293 | #291   | cli-dev    | 03-22 | PR metadata in review            |
| #294 | #284   | cli-dev    | 03-22 | Config validation                |
| #295 | #283   | server-dev | 03-22 | Structured error responses       |
| #296 | #288   | cli-dev    | 03-22 | npm publish readiness            |
| #297 | #285   | server-dev | 03-22 | Task TTL + cleanup               |
| #298 | #289   | server-dev | 03-22 | Structured logging               |
| #299 | #290   | server-dev | 03-22 | E2E integration tests            |
| #300 | #286   | cli-dev    | 03-22 | CLI UX improvements              |
| #306 | #302   | cli-dev    | 03-22 | Log file support                 |
| #310 | #307   | architect  | 03-22 | DataStore interface              |
| #311 | #308   | server-dev | 03-22 | DataStore server integration     |
| #312 | #309   | architect  | 03-22 | D1DataStore + migration          |
| #314 | #308   | server-dev | 03-22 | D1DataStore wiring fix           |
| #320 | #318   | direct     | 03-23 | Fix test suite hanging           |
| #322 | --     | direct     | 03-23 | CI baseline test                 |
| #324 | --     | direct     | 03-23 | mode:all private repo fix        |
| #317 | --     | architect  | 03-23 | VPS self-hosting support         |
| #319 | #316   | cli-dev    | 03-23 | Fix abort listener leak          |
| #329 | #326   | architect  | 03-23 | GitHub identity API types        |
| #334 | #331   | server-dev | 03-23 | Queue-based task claim flow      |
| #335 | #333   | server-dev | 03-23 | GitHubService interface extract  |
| #337 | #327   | server-dev | 03-23 | GitHub identity in eligibility   |
| #338 | #328   | cli-dev    | 03-23 | Synthesizer config + identity    |
| #339 | #336   | cli-dev    | 03-23 | Fix tsc --build CLI dist         |
| #340 | #332   | server-dev | 03-23 | Timeout review consolidation     |
| #342 | --     | direct     | 03-23 | Inject prod KV namespace in CI   |
| #358 | #350   | cli-dev    | 03-23 | SIGKILL escalation on timeout    |
| #359 | #346   | server-dev | 03-23 | Enforce allow_anonymous: false   |
| #360 | #357   | server-dev | 03-23 | Remove KVDataStore + KV fallback |
| #361 | #352   | server-dev | 03-23 | Composite DB index for dedup     |
| #362 | #355   | server-dev | 03-23 | Enforce preferred_models/tools   |
| #363 | #345   | server-dev | 03-23 | Atomic review-slot counting      |
| #364 | #343   | server-dev | 03-23 | API key authentication           |
| #365 | #356   | server-dev | 03-23 | Delete task after review posted  |
| #366 | #344   | server-dev | 03-23 | Zod request validation           |
| #369 | #367   | server-dev | 03-23 | Fix CLAIM_CONFLICT poll filter   |
| #371 | #370   | server-dev | 03-23 | Fix late review queue overwrite  |
| #374 | #368   | cli-dev    | 03-24 | Contributor profile link         |
| #375 | #351   | cli-dev    | 03-24 | Streaming diff size guard        |
| #376 | #373   | cli-dev    | 03-24 | Usage limits + token tracking    |
| #379 | #378   | server-dev | 03-24 | Remove server-side formatting    |
| #454 | #446   | architect  | 03-25 | OAuth shared types               |
| #455 | #450   | cli-dev    | 03-25 | OAuth Device Flow auth module    |
| #456 | #447   | server-dev | 03-25 | OAuth token verification         |
| #457 | #449   | server-dev | 03-25 | OAuth Device Flow proxy          |
| #458 | #451   | cli-dev    | 03-25 | Auth login/status/logout cmds    |
| #459 | #448   | server-dev | 03-25 | Verified identity in routes      |
| #460 | #452   | cli-dev    | 03-25 | Replace github-auth with OAuth   |
