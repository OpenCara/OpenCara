# PM State

## Architecture (post-v1.0 rewrite — PR #172)

Stateless REST polling service. No WebSocket, no Durable Objects, no Supabase.

| Component  | Stack                        | Notes                               |
| ---------- | ---------------------------- | ----------------------------------- |
| **Server** | Hono + Cloudflare Workers KV | `packages/server/` — portable       |
| **CLI**    | Commander + HTTP polling     | `packages/cli/` — agent runtime     |
| **Shared** | Pure TypeScript types        | `packages/shared/` — REST API types |
| **Store**  | KV (prod) / Memory (test)    | `TaskStore` abstraction             |

Flow: GitHub webhook → server creates task in KV → agent polls → claims → fetches diff from GitHub → reviews → submits result → server posts to GitHub

## Environments

| Env      | Worker                | Deploy                                 |
| -------- | --------------------- | -------------------------------------- |
| **Dev**  | `opencara-worker-dev` | `npx wrangler deploy --env dev`        |
| **Prod** | `opencara-worker`     | `npx wrangler deploy` (team lead only) |

- **`main` = dev branch** — no separate dev branch
- All feature PRs target `main`; dev worker deployed after each merge
- Production deployment is team-lead-only (version bump + tag)

## Open Issues

### Code review hardening (from proactive review, 2026-03-20)

- #175 [server-dev, HIGH] Fix reject/error to free claim slots + state machine validation — **DONE** (PR #186 merged)
- #176 [cli-dev, HIGH] Add retry logic and error recovery to agent loop — **DONE** (PR #187 merged)
- #173 [server-dev, HIGH] Harden KV store: JSON.parse try-catch + TTL on terminal tasks — **DONE** (PR #188 merged)
- #174 [server-dev, HIGH] Add retry logic and error handling for GitHub API calls — **DONE** (PR #189 merged)
- #182 [server-dev, HIGH] Add webhook idempotency — **DONE** (PR #190 merged)
- #185 [server-dev, medium] Add role validation on result submission endpoint — **PR #191 open** (CI passing, self-review)
- #177 [cli-dev, medium] Pass model/tool info in claim and result requests — **PR #192 open** (CI passing, self-review)
- #178 [cli-dev, medium] Improve RouterRelay error handling
- #184 [server-dev, medium] Optimize checkTimeouts and app creation
- #179 [server-dev, low] Improve review-parser and eligibility robustness
- #180 [cli-dev, low] Remove dead code: anonymous agents, consumption no-ops, unused params

### Pre-existing

- #156 [pm, medium] Auto-deploy dev worker on merge to main (CI/CD)
- #164 [server-dev, medium] Log error codes with agent ID + reduce priority on repeated failures
- #165 [cli-dev, medium] Add review_only config to exclude agent from synthesis
- #130 [cli, low] Clickable PR links in agent logs
- #133 [design, low] Evaluate migration to Rust or Go
- #144 [design, low] Container-based agent execution
- #162 [design, low] Local Docker dev environment (blocked by #133)

## Closed Issues (processed)

#1, #3, #4, #5, #8, #9, #11, #13, #14, #18, #19, #20, #24, #25, #26, #27,
#31, #32, #33, #34, #35, #38, #40, #41, #43, #46, #47, #48, #51, #53, #55,
#57, #58, #61, #62, #63, #64, #65, #66, #67, #69, #70, #71, #72, #73,
#80, #81, #82, #83, #84, #85, #86, #87, #88, #90, #95, #96, #99, #100,
#101, #102, #111, #112, #113, #114, #115, #120, #121, #123, #124, #125,
#126, #129, #130, #131, #132, #133, #135, #136,
#145, #146, #147, #148, #154, #155, #157, #159, #160, #166, #167, #170,
#173, #174, #175, #176, #181 (dup of #182), #182, #183 (dup of #184)

## Merged PRs (processed)

#2, #6, #7, #10, #12, #15, #16, #17, #21, #22, #23, #28, #29, #30,
#36, #37, #39, #42, #44, #45, #49, #50, #52, #54, #56, #59, #60,
#68, #74, #75, #76, #77, #78, #79, #89, #91, #92, #93, #94, #97,
#103, #104, #105, #106, #107, #108, #109, #110, #116, #117, #118,
#119, #122, #127, #128, #134, #137, #138, #139, #140, #141, #142, #143,
#149, #150, #151, #152, #153, #158, #161, #163, #168, #169, #171, #172, #186, #187, #188, #189, #190
