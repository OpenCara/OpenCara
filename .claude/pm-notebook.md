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
| **Dev**  | `opencara-server-dev` | `npx wrangler deploy --env dev`        |
| **Prod** | `opencara-server`     | `npx wrangler deploy` (team lead only) |

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
- #185 [server-dev, medium] Add role validation on result submission endpoint — **DONE** (PR #191 merged)
- #177 [cli-dev, medium] Pass model/tool info in claim and result requests — **DONE** (PR #192 merged)
- #178 [cli-dev, medium] Improve RouterRelay error handling — **DONE** (PR #193 merged)
- #184 [server-dev, medium] Optimize checkTimeouts and app creation — **DONE** (PR #194 merged)
- #179 [server-dev, low] Improve review-parser and eligibility robustness — **DONE** (PR #199 merged)
- #180 [cli-dev, low] Remove dead code: anonymous agents, consumption no-ops, unused params — **DONE** (PR #200 merged)

### Bug fix (QA-discovered, 2026-03-20)

- #201 [server-dev, HIGH] Fix verdict case mismatch causing invisible draft reviews — **DONE** (PR #203 merged)

### Bug fix (2026-03-21)

- #221 [server-dev, HIGH] Fix duplicate summary claims race condition (KV eventual consistency) — **DONE** (PR #222 merged)

### Pre-existing

- #156 [architect, medium] Auto-deploy dev worker on merge to main (CI/CD) — **DONE** (PR #207 merged)
- #164 [server-dev, medium] Log error codes with agent ID + reduce priority on repeated failures — **DONE** (PR #197 merged)
- #165 [cli-dev, medium] Add review_only config to exclude agent from synthesis — **DONE** (PR #195 merged)
- #130 [cli-dev, low] Clickable PR links in agent logs — **DONE** (PR #206 merged, direct commit)
- #133 [design, low] Evaluate migration to Rust or Go — **CLOSED** (wontfix, committed to TypeScript)
- #144 [design, low] Container-based agent execution — **CLOSED** (superseded by #211)
- #162 [design, low] Local Docker dev environment — **CLOSED** (stale, wrangler dev covers use case)

### Bug fix (QA-discovered, 2026-03-21)

- #225 [cli-dev, HIGH] Docker build fails: missing tsconfig.json in build context — **DONE** (PR #226 merged)

### New features (2026-03-21)

- #210 [cli-dev, medium] Clone project codebase locally for context-aware code review — **DONE** (PR #219 merged, follow-up PR #220 merged)
- #211 [cli-dev, medium] Dockerfile + docker-compose.yml for containerized agent deployment — **DONE** (PR #223 merged)
- #212 [cli-dev, medium] Unified GitHub auth with 4-tier fallback chain — **DONE** (PR #215 merged)
- #213 [server-dev, medium] Enforce reviewer/summarizer whitelist/blacklist with agent ID filtering — **DONE** (PR #214 merged)
- #216 [server-dev, medium] Add preferred synthesizer config in .review.yml — **DONE** (PR #224 merged)
- #217 [server-dev, medium] Switch from PR Review API to issue comments — **DONE** (PR #218 merged)

### Code review audit (from external reports, 2026-03-21)

- #228 [server-dev, HIGH] Security: .review.yml read from PR head branch allows config manipulation — **DONE** (PR #243 merged)
- #229 [server-dev, HIGH] KV store race conditions: non-atomic read-modify-write operations — **DONE** (PR #247 merged)
- #230 [server-dev, HIGH] Reviewer/summarizer whitelist: user field parsed but never enforced — **DONE** (PR #244 merged)
- #231 [server-dev, HIGH] Repo filtering config parsed but not enforced in poll endpoint — **DONE** (PR #246 merged)
- #232 [server-dev, medium] Timeout check relies on Worker isolate memory, not persistent state — **DONE** (PR #260 merged, PR #259 superseded)
- #233 [cli-dev, medium] Retry logic missing jitter causes thundering herd — **DONE** (PR #250 merged)
- #234 [server-dev, medium] Add rate limiting to API endpoints — **DONE** (PR #263 merged, PR #262 superseded)
- #235 [cli-dev, medium] AbortSignal not passed to fetch() in fetchDiff — **DONE** (PR #249 merged)
- #236 [cli-dev, medium] api_key config field never passed to ApiClient — **DONE** (PR #251 merged)
- #237 [cli-dev, medium] Consumption limits parsed but never enforced — **DONE** (PR #252 merged)
- #238 [cli-dev, medium] Token sanitization incomplete — only covers git errors — **DONE** (PR #255 merged)
- #239 [server-dev, low] Add health check and basic metrics endpoint — **DONE** (PR #268 merged)
- #240 [server-dev, low] Dead config fields: autoApprove, minReputation, defaultReputation — **DONE** (PR #267 merged)
- #241 [server-dev, low] KV listTasks performance: O(n) scan of entire task index on every poll — **CLOSED** (already resolved by PR #247)
- #242 [server-dev, low] GitHub installation token not refreshed for long-running tasks — **CLOSED** (N/A, token refresh already works correctly)

### User-requested (2026-03-22)

- #245 [cli-dev, medium] Auto-shutdown agent after too many consecutive errors — **DONE** (PR #253 merged)

### User-requested (2026-03-22)

- #256 [cli-dev, medium] Use task ID as subdirectory in codebase_dir to avoid concurrent task conflicts — **DONE** (PR #264 merged)

### Critical bug (team-lead reported, 2026-03-22)

- #254 [server-dev, HIGH] Summary reviews silently not posted due to KV read-after-write inconsistency — **DONE** (PR #258 merged)

### Test coverage (user-requested, 2026-03-22)

- #257 [cli-dev, medium] Increase test coverage to near 100% across all packages — **DONE** (96.75% accepted, PR #261 merged)

### Test regression (post-merge, 2026-03-22)

- #265 [cli-dev, HIGH] Fix 10 test failures caused by PR #260 export default change — **DONE** (PR #266 merged)

### Bug fix (user-reported, 2026-03-22)

- #269 [cli-dev, HIGH] Environment variable OPENCARA_PLATFORM_URL does not override platform_url config — **DONE** (PR #270 merged)
- #271 [cli-dev, medium] Add env var overrides for remaining 5 CLI config fields (follow-up to #269) — **CLOSED** (not needed, OPENCARA_PLATFORM_URL + OPENCARA_CONFIG sufficient)

## Closed Issues (processed)

#1, #3, #4, #5, #8, #9, #11, #13, #14, #18, #19, #20, #24, #25, #26, #27,
#31, #32, #33, #34, #35, #38, #40, #41, #43, #46, #47, #48, #51, #53, #55,
#57, #58, #61, #62, #63, #64, #65, #66, #67, #69, #70, #71, #72, #73,
#80, #81, #82, #83, #84, #85, #86, #87, #88, #90, #95, #96, #99, #100,
#101, #102, #111, #112, #113, #114, #115, #120, #121, #123, #124, #125,
#126, #129, #130, #131, #132, #133, #135, #136,
#145, #146, #147, #148, #154, #155, #157, #159, #160, #166, #167, #170,
#173, #174, #175, #176, #177, #178, #179, #180, #181 (dup of #182), #182, #183 (dup of #184), #184, #185, #164, #165, #201, #156, #210, #211, #212, #213, #216, #217, #221, #144, #225, #228, #229, #230, #231, #232, #233, #234, #235, #236, #237, #238, #239, #240, #241, #242, #245, #254, #256, #257, #265, #269, #271, #272, #273, #276, #277, #278, #280, #282, #283, #284, #285, #286, #287, #288, #289, #290, #291, #301, #303, #304, #305, #307, #308, #309, #313, #318

## Merged PRs (processed)

#2, #6, #7, #10, #12, #15, #16, #17, #21, #22, #23, #28, #29, #30,
#36, #37, #39, #42, #44, #45, #49, #50, #52, #54, #56, #59, #60,
#68, #74, #75, #76, #77, #78, #79, #89, #91, #92, #93, #94, #97,
#103, #104, #105, #106, #107, #108, #109, #110, #116, #117, #118,
#119, #122, #127, #128, #134, #137, #138, #139, #140, #141, #142, #143,
#149, #150, #151, #152, #153, #158, #161, #163, #168, #169, #171, #172, #186, #187, #188, #189, #190, #191, #192, #193, #194, #195, #197, #198, #196, #199, #200, #202, #203, #204, #205, #206, #207, #208, #209, #214, #215, #218, #219, #220, #222, #223, #224, #226, #227, #243, #244, #246, #247, #248, #249, #250, #251, #252, #253, #255, #258, #260, #261, #263, #264, #266, #267, #268, #270, #274, #275, #279, #281, #292, #293, #294, #295, #296, #297, #298, #299, #300, #306, #310, #311, #312, #314, #320, #322, #324

### Milestone QA (2026-03-22)

- #272 [qa] Milestone M11 QA Checklist — **DONE** (36/37 passed, #257 coverage gap accepted at 96.75%)
- #303 [qa] Milestone M12 QA Checklist — **DONE**

### Critical bug (team-lead reported, 2026-03-22)

- #273 [server-dev, HIGH] Duplicate summary reviews from concurrent KV claim races — **DONE** (PR #274 merged, PR #275 race tests merged, 733 tests. Review claim race confirmed benign — no fix needed per YAGNI)

### M12: Operational Maturity & DX

#### High

- #282 [server-dev+cli-dev+shared] Private repo task isolation — filter private repo tasks in poll — **DONE** (PR #292 merged)
- #291 [cli-dev] Include PR metadata and discussion context in review input — **DONE** (PR #293 merged)

#### Medium

- #276 [server-dev] GitHub API dedup guard for summary review posting — **CLOSED** (not planned, KV lock sufficient)
- #280 [cli-dev] Always set repo-scoped working directory for review commands — **DONE** (PR #281 merged)
- #283 [server-dev] Structured error responses with error codes — **DONE** (PR #295 merged)
- #284 [cli-dev] Config validation with actionable error messages — **DONE** (PR #294 merged)
- #285 [server-dev] Task TTL and automatic cleanup of stale tasks — **DONE** (PR #297 merged)
- #288 [cli-dev] npm publish readiness: package.json, README, bin entry — **DONE** (PR #296 merged)
- #289 [server-dev] Structured logging with request IDs — **DONE** (PR #298 merged)
- #290 [server-dev] E2E integration tests with mock GitHub API — **DONE** (PR #299 merged)

### User-requested (2026-03-22)

- #301 [cli-dev, medium] Configurable error retry limit before agent shutdown — **CLOSED**
- #302 [cli-dev, medium, backlog] Save agent logs to file for debugging — **BACKLOG** (do not dispatch)

#### Low

- #286 [cli-dev] CLI UX: progress indicators and colored output — **DONE** (PR #300 merged)
- #287 [pm] Docs refresh for v1.0+ features — **DONE** (direct commit to main)

#### Done (early)

- #277 [cli-dev] Log the actual command executed — **DONE** (PR #279)
- #278 [cli-dev] Log PR URL instead of diff URL — **DONE** (PR #279)

### M13: D1 Database Layer (2026-03-22)

- #304 [breakdown] Introduce D1 with abstract SQL layer — **CLOSED** (broken down → #307, #308, #309)
- #305 [breakdown] Introduce D1 with abstract SQL layer (dup of #304) — **CLOSED**
- #307 [architect, HIGH] Define DataStore interface + MemoryDataStore — **DONE** (PR #310 merged)
- #308 [server-dev, HIGH] Integrate DataStore into server routes — **DONE** (PR #311, PR #314 merged)
- #309 [architect, HIGH] D1DataStore implementation + migration SQL + wrangler config — **DONE** (PR #312 merged)
- #313 [qa] Milestone M13 QA Checklist — **DONE**

### Bug fixes (2026-03-23)

- #318 [qa, medium] Investigate increased test suite duration — **DONE** (PR #320 merged)
- #316 [cli-dev, medium] Fix MaxListenersExceededWarning from abort listener leak in sleep() — **IN PROGRESS** (PR #319 open)

### Documentation (2026-03-23)

- #315 [pm/docs] Document wrangler version requirement for local D1 dev — **OPEN** (docs only)

### VPS self-hosting (2026-03-23)

- PR #317 [architect] Add VPS self-hosting support — **OPEN** (in review)

## Open PRs

- #317 [architect] Add VPS self-hosting support
- #319 [cli-dev] Fix MaxListenersExceededWarning from abort listener leak
