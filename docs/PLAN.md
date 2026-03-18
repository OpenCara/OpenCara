# OpenCara — Project Plan

## Overview

Distributed AI code review service. Contributors run review agents locally, the platform coordinates multi-agent reviews on GitHub PRs, and a reputation system ranks agents.

## MVP Milestones [ALL DONE]

### M0: Project Scaffolding — #1 -> PR #2

pnpm monorepo with 4 packages (shared, worker, cli, web). TypeScript strict mode, ESLint 9, Prettier, Vitest, GitHub Actions CI.

### M1: GitHub App + Webhook — #4 -> PR #7

Platform receives PR events. HMAC-SHA256 validation, .review.yml parsing, GitHub API client with JWT auth.

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

## Post-MVP [DONE]

Completed 50+ post-MVP items across these areas:

- **Stability**: WebSocket fixes (#51-57,#61,#62,#102), reconnect, ping frames
- **Review quality**: PR Review API (#82,#83,#96), inline comments (#136), synthesizer redesign (#110)
- **Configuration**: trigger control (#99), preferred_models (#84), tool commands (#63), stability threshold (#73)
- **Architecture**: pnpm migration (#58), schema simplification 9->7 tables (#121), dashboard redesign (#64)
- **Agent features**: local-config agents (#86), --all flag (#85), repo filtering (#112), anonymous agents (#123), agent details in reviews (#135)
- **Infrastructure**: deployment (#40), CORS/security (#43), npm publishing CI (#132,#140-143)
- **CLI**: local tools (#47), token counting (#87), stats enrichment (#72), contributor profiles (#101)
- **Rebrand**: OpenCrust -> OpenCara (#91,#92)

## Open Issues

| #    | Agent              | Priority | Description                                          |
| ---- | ------------------ | -------- | ---------------------------------------------------- |
| #129 | worker-dev+cli-dev | medium   | Custom agent names in review logs and comments       |
| #131 | worker-dev         | medium   | Default reputation scores per model                  |
| #144 | cli-dev            | medium   | Run agent in container — Dockerfile, config, docs    |
| #38  | worker-dev         | low      | Installation event handlers — project upsert/cleanup |
| #80  | cli-dev            | low      | Growth trends in stats                               |
| #81  | cli-dev            | low      | Expertise areas in stats                             |
| #90  | worker-dev         | low      | Dynamic tool/model registry                          |
| #130 | cli-dev            | low      | Clickable PR links in agent logs                     |
| #133 | design             | low      | Evaluate migration to Rust or Go                     |

## Merged PRs

| PR   | Issue  | Agent      | Date  | Description                 |
| ---- | ------ | ---------- | ----- | --------------------------- |
| #2   | #1     | architect  | 03-16 | M0 Monorepo setup           |
| #6   | #5     | worker-dev | 03-16 | M2 DB schema + auth         |
| #7   | #4     | worker-dev | 03-16 | M1 Webhook endpoint         |
| #10  | #8     | cli-dev    | 03-16 | M3 CLI connect              |
| #12  | #9     | worker-dev | 03-16 | M4 Durable Objects          |
| #15  | #11    | architect  | 03-16 | Test coverage 100%          |
| #16  | #14    | cli-dev    | 03-16 | M5 CLI review engine        |
| #17  | #13    | worker-dev | 03-16 | M5 Worker review posting    |
| #21  | #18    | architect  | 03-16 | Fix typecheck/format        |
| #22  | #20    | cli-dev    | 03-16 | M6 CLI summary engine       |
| #23  | #19    | worker-dev | 03-16 | M6 Multi-agent dispatch     |
| #28  | #26    | worker-dev | 03-16 | M9 Consumption API          |
| #29  | #25    | worker-dev | 03-16 | M7 Reputation system        |
| #30  | #27    | cli-dev    | 03-16 | M9 CLI stats                |
| #36  | #33    | worker-dev | 03-16 | M8 OAuth callback           |
| #37  | #31,32 | web-dev    | 03-16 | M8 Landing + leaderboard    |
| #39  | #34    | web-dev    | 03-16 | M8 Dashboard                |
| #42  | #40    | architect  | 03-16 | Deployment guide            |
| #44  | #41    | web-dev    | 03-16 | Dashboard fixes             |
| #45  | #43    | worker-dev | 03-16 | CORS + security             |
| #49  | #47    | cli-dev    | 03-16 | Local tools refactor        |
| #50  | #48    | worker-dev | 03-16 | Pending task pickup         |
| #52  | #51    | worker-dev | 03-16 | WS auth disconnect fix      |
| #54  | #53    | worker-dev | 03-16 | WS reconnect loop fix       |
| #56  | #55    | worker-dev | 03-16 | WS re-entrance fix          |
| #59  | #57,46 | worker-dev | 03-17 | E2E review loop fix         |
| #60  | #58    | architect  | 03-17 | pnpm migration              |
| #68  | #61,62 | cli-dev    | 03-17 | WS diagnostics + tool fix   |
| #74  | #69    | architect  | 03-17 | Trust tier types            |
| #75  | #70,35 | worker-dev | 03-17 | Project stats API           |
| #76  | #63    | cli-dev    | 03-17 | Tool command templates      |
| #77  | #71    | web-dev    | 03-17 | Web community page          |
| #78  | #72    | cli-dev    | 03-17 | Stats enrichment            |
| #79  | #73    | cli-dev    | 03-17 | Stability threshold         |
| #89  | #86    | cli-dev    | 03-17 | Local-config agents         |
| #91  | --     | direct     | 03-17 | Rebrand to OpenCara         |
| #92  | --     | direct     | 03-17 | Post-rebrand fixes          |
| #93  | #82,83 | direct     | 03-17 | PR Review API               |
| #94  | #87    | direct     | 03-17 | Token counting fix          |
| #97  | #95,96 | direct     | 03-17 | Inline PR review comments   |
| #103 | #99    | direct     | 03-17 | Trigger control             |
| #104 | #84    | direct     | 03-17 | preferred_models            |
| #105 | #102   | direct     | 03-17 | WebSocket ping frames       |
| #106 | #101   | direct     | 03-17 | Contributor profiles        |
| #107 | #100   | direct     | 03-17 | Drop diff_content storage   |
| #108 | #88    | direct     | 03-17 | Timeout comment + retry     |
| #109 | #85    | direct     | 03-17 | --all agent start           |
| #110 | --     | direct     | 03-18 | E2E tests + synthesizer     |
| #116 | #113   | architect  | 03-18 | Repo config types           |
| #117 | #111   | worker-dev | 03-18 | Load balancing              |
| #118 | #114   | worker-dev | 03-18 | Repo filtering              |
| #119 | #115   | cli-dev    | 03-18 | Repo config CLI             |
| #122 | #121   | architect  | 03-18 | Schema simplification       |
| #127 | #124   | architect  | 03-18 | Anonymous agent types       |
| #128 | #125   | worker-dev | 03-18 | Anonymous registration      |
| #134 | #126   | cli-dev    | 03-18 | Anonymous CLI support       |
| #137 | #136   | worker-dev | 03-18 | Synthesizer inline comments |
| #138 | #132   | architect  | 03-18 | npm publish CI              |
| #139 | #135   | worker-dev | 03-18 | Agent details in reviews    |
| #140 | --     | direct     | 03-18 | OIDC npm publishing         |
| #141 | --     | direct     | 03-18 | Test publish pipeline       |
| #142 | --     | direct     | 03-18 | npm publish with token      |
| #143 | --     | direct     | 03-18 | Test OIDC publishing        |
