# PM State

## Architecture (post-v1.0 rewrite — PR #172)

Stateless REST polling service. No WebSocket, no Durable Objects, no Supabase.

| Component  | Stack                        | Notes                               |
| ---------- | ---------------------------- | ----------------------------------- |
| **Server** | Hono + Cloudflare Workers D1 | `packages/server/` — portable       |
| **CLI**    | Commander + HTTP polling     | `packages/cli/` — agent runtime     |
| **Shared** | Pure TypeScript types        | `packages/shared/` — REST API types |
| **Store**  | D1 (prod) / Memory (test)    | `DataStore` abstraction             |

Flow: GitHub webhook → server creates task in D1 → agent polls → claims → fetches diff from GitHub → reviews → submits result → server posts to GitHub

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
- #216 [server-dev, medium] Add preferred synthesizer config in .review.toml — **DONE** (PR #224 merged)
- #217 [server-dev, medium] Switch from PR Review API to issue comments — **DONE** (PR #218 merged)

### Code review audit (from external reports, 2026-03-21)

- #228 [server-dev, HIGH] Security: .review.toml read from PR head branch allows config manipulation — **DONE** (PR #243 merged)
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
#173, #174, #175, #176, #177, #178, #179, #180, #181 (dup of #182), #182, #183 (dup of #184), #184, #185, #164, #165, #201, #156, #210, #211, #212, #213, #216, #217, #221, #144, #225, #228, #229, #230, #231, #232, #233, #234, #235, #236, #237, #238, #239, #240, #241, #242, #245, #254, #256, #257, #265, #269, #271, #272, #273, #276, #277, #278, #280, #282, #283, #284, #285, #286, #287, #288, #289, #290, #291, #301, #303, #304, #305, #307, #308, #309, #313, #318, #315, #316, #325, #326, #327, #328, #330, #331, #332, #333, #336, #341, #343, #344, #345, #346, #347, #349, #350, #352, #351, #353, #354, #355, #356, #357, #367, #368, #370, #372, #373, #378, #380, #381, #384, #385, #386, #388, #391, #392, #393, #394, #395, #396, #401, #405, #406, #407, #408, #411, #412, #414, #415, #428, #430, #431

## Merged PRs (processed)

#2, #6, #7, #10, #12, #15, #16, #17, #21, #22, #23, #28, #29, #30,
#36, #37, #39, #42, #44, #45, #49, #50, #52, #54, #56, #59, #60,
#68, #74, #75, #76, #77, #78, #79, #89, #91, #92, #93, #94, #97,
#103, #104, #105, #106, #107, #108, #109, #110, #116, #117, #118,
#119, #122, #127, #128, #134, #137, #138, #139, #140, #141, #142, #143,
#149, #150, #151, #152, #153, #158, #161, #163, #168, #169, #171, #172, #186, #187, #188, #189, #190, #191, #192, #193, #194, #195, #197, #198, #196, #199, #200, #202, #203, #204, #205, #206, #207, #208, #209, #214, #215, #218, #219, #220, #222, #223, #224, #226, #227, #243, #244, #246, #247, #248, #249, #250, #251, #252, #253, #255, #258, #260, #261, #263, #264, #266, #267, #268, #270, #274, #275, #279, #281, #292, #293, #294, #295, #296, #297, #298, #299, #300, #306, #310, #311, #312, #314, #317, #319, #320, #322, #324, #329, #334, #335, #337, #338, #339, #340, #342, #358, #359, #360, #361, #362, #363, #364, #365, #366, #369, #371, #374, #375, #376, #379, #382, #383, #387, #389, #390, #398, #399, #400, #402, #416, #417, #418, #419, #420, #421, #422, #425, #426, #429

### Milestone QA (2026-03-22)

- #272 [qa] Milestone M11 QA Checklist — **DONE** (36/37 passed, #257 coverage gap accepted at 96.75%)
- #303 [qa] Milestone M12 QA Checklist — **DONE**
- #313 [qa] Milestone M13 QA Checklist — **DONE**
- #341 [qa] Milestone M14 QA Checklist — **DONE** (7/7 passed, all clean)
- #372 [qa] Milestone M15 QA Checklist — **DONE** (11/11 passed, all clean)

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
- #316 [cli-dev, medium] Fix MaxListenersExceededWarning from abort listener leak in sleep() — **DONE** (PR #319 merged)

### Documentation (2026-03-23)

- #315 [pm/docs] Document wrangler version requirement for local D1 dev — **DONE** (closed)

### VPS self-hosting (2026-03-23)

- PR #317 [architect] Add VPS self-hosting support — **DONE** (merged 2026-03-23)

### M14 Active Agents (2026-03-23)

- #327 [server-dev] Enforce GitHub identity in synthesizer eligibility — **DONE** (PR #337 merged)
- #328 [cli-dev] Add synthesizer_only config and send identity in poll/claim — **DONE** (PR #338 merged)
- #325 [breakdown] Synthesizer identity and role-based agent configuration — **CLOSED** (all sub-tasks done)
- #332 [server-dev] Consolidate timeout partial reviews — **DONE** (PR #340 merged)

### Build bug (qa-discovered, 2026-03-23)

- #336 [cli-dev, HIGH] CLI dist broken by tsc --build: **CLI_VERSION** not replaced — **DONE** (PR #339 merged)

### M15: Production Readiness (2026-03-23)

#### High Priority

- #343 [server-dev, HIGH] API key authentication for task endpoints — **DONE** (PR #364 merged)
- #344 [server-dev, HIGH] Runtime request validation with Zod schemas — **DONE** (PR #366 merged)
- #345 [server-dev, HIGH] Atomic review-slot counting to prevent oversubscription — **DONE** (PR #363 merged)
- #346 [server-dev, HIGH] Enforce allow_anonymous: false in reviewer eligibility — **DONE** (PR #359 merged)

#### Medium Priority

- #347 [server-dev, medium] Heartbeat-based claim expiry and lock TTL — **DONE** (PR #421 merged)
- #348 [server-dev, medium] Webhook event log for delivery visibility — **BACKLOG**
- #349 [server-dev, medium] Agent activity endpoint with heartbeats and claim history — **DONE** (PR #422 merged)
- #350 [cli-dev, medium] SIGKILL escalation after SIGTERM timeout — **DONE** (PR #358 merged)
- #351 [cli-dev, medium] Streaming diff size guard to prevent OOM — **DONE** (PR #375 merged)
- #352 [server-dev, medium] Add composite DB index for webhook dedup query — **DONE** (PR #361 merged)
- #355 [server-dev, medium] Enforce preferred_models/preferred_tools in task polling — **DONE** (PR #362 merged)
- #356 [server-dev, medium] Delete task and claims immediately after review posted — **DONE** (PR #365 merged)
- #357 [server-dev, medium] Remove KVDataStore, KV fallback, and locks table — **DONE** (PR #360 merged)

#### Bug Fixes

- #367 [server-dev, HIGH] Fix CLAIM_CONFLICT spam: filter already-claimed summary tasks in poll — **DONE** (PR #369 merged)
- #370 [server-dev, HIGH] Fix late review results overwriting summary queue state — **DONE** (PR #371 merged)

#### New Features

- #368 [cli-dev, medium] Display contributor GitHub profile link in review report — **DONE** (PR #374 merged)
- #373 [cli-dev, medium] Per-day review cap, token budget, and accurate token tracking — **DONE** (PR #376 merged)

#### Low Priority

- #353 [architect, low] Production deploy CI workflow (tag-triggered) — **CLOSED** (already exists in publish-cli.yml deploy-prod job)
- #354 [cli-dev, low] Add opencara status command for diagnostics — **DONE** (PR #420 merged)
- #302 [cli-dev, medium] Save agent logs to file for debugging — **BACKLOG** (pre-existing)

### New (2026-03-24)

- #378 [server-dev, P2, M] Refine review report format: split agents, add verdict — **DONE** (PR #379 merged, QA PASS 2026-03-24)
- #380 [cli-dev, P2, S] Prompt reviewers/synthesizers to include metadata headers in output — **DONE** (PR #383 merged, QA PASS 2026-03-24)
- #381 [server-dev, P2, XS] Wrap review_text with title header and footer — **DONE** (PR #382 merged, QA PASS 2026-03-24)

### Bug fixes (2026-03-24)

- #386 [cli-dev, HIGH] Fix metadata headers missing from bot output (review prompts ignored by AI) — **DONE** (PR #387 merged, QA PASS 2026-03-24)
- #388 [cli-dev, HIGH] Router-mode review paths missing metadata headers (follow-up to #386) — **DONE** (PR #389 merged, QA PASS 2026-03-24)

### Scriptify patterns (2026-03-24)

- #384 [pm, low] Script: list-issues-by-status.sh — **DONE** (direct commit 2026-03-24)
- #385 [pm, low] Script: poll-github.sh — **DONE** (direct commit 2026-03-24)

### Release strategy (2026-03-24)

- #391 [breakdown, HIGH] Adopt CF Workers Versions & Deployments for rolling releases — **DONE** (closed)
  - #392 [server-dev, HIGH] Add /api/meta endpoint + CLI version check middleware — **DONE** (PR #398 merged)
  - #393 [cli-dev, HIGH] Send X-OpenCara-CLI-Version header in all API requests — **DONE** (PR #399 merged)
  - #394 [architect, HIGH] Create scripts/release.sh for CF Versions workflow — **DONE** (PR #400 merged)
  - #395 [architect, medium] Add release-prod.yml CI workflow — **DONE** (PR #400 merged, combined with #394)
  - #396 [pm, medium] Update docs/deployment.md with new release workflow — **DONE** (direct commit 4229aa8)
  - #397 [cli-dev, low] Support Cloudflare-Workers-Version-Overrides header — **DONE** (PR #402 merged)

### PM tooling (2026-03-24)

- #401 [pm, medium] Local webhook receiver for real-time GitHub event notification — **DONE** (direct commit d78c531)

### Cleanup (2026-03-24)

- #403 [pm, low] Remove CLI Dockerfile — **DONE** (direct commit, closed)
- #404 [design, low] Security sandbox container design — **BACKLOG**

### M16: Report Process & Trust Hardening (2026-03-24)

- #408 [breakdown, P1, M] Parent issue — **CLOSED** (all bug-fix sub-tasks done)
- #405 [server-dev, P2, S] Non-atomic PR dedup bug — **DONE** (PR #419 merged)
- #406 [server-dev, P2, S] Stale-read slot release bug — **DONE** (PR #417 merged)
- #407 [server-dev, P2, S] Config bypass on comment trigger bug — **DONE** (PR #418 merged)
- #409 [server-dev, P1, S] prompt_hash server-side — **BACKLOG**
- #410 [cli-dev, P1, S] prompt_hash CLI-side — **BACKLOG**
- #411 [server-dev, P1, S] Validate review_text — **DONE** (PR #426 merged, QA PASS 2026-03-25)
- #412 [cli-dev, P1, S] Anti-injection framing — **DONE** (PR #425 merged, QA PASS 2026-03-25)
- #413 [server-dev, P2, XS] prompt_max_length validation — **DONE** (PR #429 merged, QA PASS 2026-03-25)
- #414 [server-dev, P2, S] POST /api/config/validate endpoint — **DONE** (PR #416 merged)
- #415 [pm, P2, S] Document prompt security best practices — **DONE** (docs/security.md updated with anti-injection framing, prompt guard, review validation, abuse tracking, closed)

### New issues (2026-03-25)

- #423 [server-dev, P2, M] Add model/tool constraint for synthesizer in .review.toml — **BACKLOG**
- #424 [architect, P1, L] Reorganize .review.toml into modular feature sections (v2 config) — **BACKLOG**
- #427 [cli-dev, P2, S] Add --verbose mode to log tool stdout/stderr — **BACKLOG**
- #428 [architect, P2, S] Add amp to tool registry and update contributor docs — **BACKLOG** (deferred — amp -x requires paid credits, 402 error, closed)
- #430 [pm, P3, XS] Update docs to use canonical tool names from registry — **DONE** (agent-guide.md claude-code→claude)
- #431 [pm, P2, M] Improve local-agent.md as comprehensive contributor guide — **DONE** (commit 5042484, closed)

### Dedup Feature (2026-03-25)

#### PR Dedup

- #432 [architect, P1, M] Add dedup+triage roles to shared types and .review.toml parser — **BACKLOG** (blocks all dedup and triage issues)
- #433 [server-dev, P1, M] Create dedup tasks on PR webhook alongside review tasks — **BACKLOG** (blocked by #432)
- #434 [server-dev, P1, L] Handle dedup role in claim/result endpoints and post dedup comment — **BACKLOG** (blocked by #432)
- #435 [cli-dev, P1, L] Dedup agent execution: two-phase comparison and similarity report — **BACKLOG** (blocked by #432)
- #436 [cli-dev, P1, L] Dedup synthesizer: merge reports, post decision, update PR index — **BACKLOG** (blocked by #432, #435)

#### Issue Dedup

- #437 [server-dev, P1, M] Create dedup tasks on issue webhook — **BACKLOG** (blocked by #432)
- #438 [server-dev, P1, L] Handle issue dedup in claim/result endpoints, post dedup comment — **BACKLOG** (blocked by #432)
- #439 [cli-dev, P1, L] Issue dedup agent: semantic comparison of title+body — **BACKLOG** (blocked by #432)
- #440 [cli-dev, P1, L] Issue dedup synthesizer: merge reports, update issue index — **BACKLOG** (blocked by #432, #439)

### Issue Triage Feature (2026-03-25)

- ~~#441~~ — **CLOSED** (merged into #432)
- #442 [server-dev, P1, S] Create triage tasks on issue webhook — **BACKLOG** (blocked by #432)
- #443 [server-dev, P1, M] Handle triage result: rewrite/comment issue and apply labels — **BACKLOG** (blocked by #432)
- #444 [cli-dev, P1, M] Triage agent: issue categorization and structured report — **BACKLOG** (blocked by #432)

### M17: GitHub App OAuth Authentication (2026-03-25)

- #445 [breakdown] GitHub App OAuth Authentication — **CLOSED** (all 7 code issues QA verified)
  - #446 [architect, P1, M] Add OAuth auth types and remove self-reported identity — **DONE** (PR #454, QA PASS)
  - #447 [server-dev, P1, L] OAuth token verification middleware with D1 caching — **DONE** (PR #456, QA PASS)
  - #448 [server-dev, P1, M] Derive agent identity from verified OAuth token in routes — **DONE** (PR #459, QA PASS)
  - #449 [server-dev, P1, M] Add OAuth Device Flow proxy endpoints — **DONE** (PR #457, QA PASS)
  - #450 [cli-dev, P1, L] OAuth Device Flow auth module with token storage and refresh — **DONE** (PR #455, QA PASS)
  - #451 [cli-dev, P1, S] Add opencara auth login/status/logout commands — **DONE** (PR #458, QA PASS)
  - #452 [cli-dev, P1, L] Replace github-auth.ts with OAuth token for diff fetch + API auth — **DONE** (PR #460, QA PASS)
  - #453 [pm, P2, M] GitHub App OAuth configuration and documentation — **DONE** (direct commit 4484116)

### M18: Config v2 — TOML + Modular Sections (2026-03-26)

Parent: #424

#### Phase 1: Foundation (blocks all)

- #463 [architect, P1, M] Replace yaml with smol-toml, define ReviewConfigV2 types + TOML parser — **DONE** (PR #478 merged, QA PASS 2026-03-26)

#### Phase 2: Server + CLI integration (parallel, after Phase 1)

- #464 [server-dev, P1, M] Integrate TOML config v2 into server routes and webhook handler — **DONE** (already completed by PR #478, no separate PR needed)
- #465 [cli-dev, P1, M] Migrate CLI config from YAML to TOML format — **DONE** (PR #479 merged, QA PASS 2026-03-26)

#### Phase 3: Docs (after Phase 2)

- #466 [pm, P2, S] Update all docs for TOML config v2 migration — **DONE** (already completed by PR #478, verified by PM)

### Bug reports (2026-03-26)

- #462 [server-dev, P1, M] Summary claim timeout causes stuck task — no retry — **DONE** (PR #467 merged, QA PASS 2026-03-26)
- #468 [server-dev, P1, M] Validate summary report quality before posting — reject empty/too-short and re-queue — **DONE** (PR #472 merged, QA PASS 2026-03-26)
- #469 [architect, P2, M] Add thinking level field alongside model and tool — **DONE** (PR #470 merged, QA PASS 2026-03-26)
- ~~#471~~ [cli-dev] CLI: per-tool directory isolation — **CLOSED** (superseded by #473)
- #473 [cli-dev, P2, M] CLI: persistent repo cache with git worktrees for review checkouts — **BACKLOG**
- #474 [cli-dev, P1, M] CLI: 2-tier diff fetch (gh CLI → HTTP fallback) — **DONE** (PR #476 merged, QA PASS 2026-03-26)
- ~~#475~~ [server-dev] Installation token in claim response — **CLOSED** (dropped, security concern)

### Code review findings (#480 breakdown, 2026-03-26)

Parent: #480

#### High Priority (P1) — DONE (QA PASS 2026-03-26)

- #481 [cli-dev, P1, S] Wrap untrusted PR context in anti-injection boundaries — **DONE** (PR #491 merged, QA PASS)
- #482 [architect, P1, M] Add network timeouts to all outbound fetch calls — **DONE** (PR #493 merged, QA PASS)
- #483 [server-dev, P1, S] Return 503 for transient webhook failures — **DONE** (PR #492 merged, QA PASS)
- #484 [cli-dev, P1, S] Remove token from git clone URL — use credential helper or env approach — **DONE** (PR #491 merged, QA PASS)

#### Medium Priority (P2) — DONE (QA PASS 2026-03-26)

- #485 [server-dev, P2, M] Batch poll endpoint queries to eliminate N+1 pattern — **DONE** (PR #494 merged, QA PASS)
- #486 [architect, P2, S] Unify OAuth token validation schema across server and CLI — **DONE** (PR #495 merged, QA PASS)
- #487 [server-dev, P2, S] Use UPDATE...RETURNING for atomic read-after-write in D1 store — **DONE** (PR #494 merged, QA PASS)
- #488 [architect, P2, M] Extract explicit task lifecycle state machine — **DONE** (PR #495 merged, QA PASS)
- #489 [server-dev, P2, S] Fix timing-safe comparison to not leak API key length — **DONE** (PR #494 merged, QA PASS)
- #490 [architect, P2, S] Fix duplicate migration number prefix (0010) — **DONE** (PR #495 merged, QA PASS)

#### Low Priority (Deferred — not broken out)

- Finding #11: Silent failures in rate limiter cleanup
- Finding #12: Missing length limits on model/tool fields
- Finding #13: Logger PII leakage
- Finding #14: Hardcoded magic numbers

### New features (2026-03-26)

- @mention trigger alias (no issue) — **DONE** (PR #496 merged, QA PASS)

### Bug reports (2026-03-26, batch 2)

- #497 [cli-dev, P1, S] Codebase clone uses wrong token — should use gh CLI like diff fetch — **IN REVIEW** (PR #498 QA FAIL → PR #499 merged with `gh repo clone` fix)

### Cleanup (2026-03-26)

- #500 [architect, P2, M] Remove anonymous agent mode from codebase — **READY** (M17 cleanup)

### QA pending (In review)

- #497 — Codebase clone auth fix v2 (PR #499 merged)

## Open PRs

(none)

## Merged PRs (pending processing)

(none)

## Recently processed

- PR #499 [cli-dev-497-fix] merged 2026-03-26 — codebase clone uses gh repo clone (v2 fix)
- PR #498 [cli-dev-497] merged 2026-03-26 — codebase clone uses gh auth token (QA FAIL)
- PR #496 [server-dev-trigger] merged 2026-03-26 — @mention trigger alias for slash commands
- PR #495 [architect-486] merged 2026-03-26 — OAuth schema, task lifecycle, migration numbering
- PR #494 [server-dev-485] merged 2026-03-26 — batch poll queries, D1 RETURNING, timing-safe auth
- PR #493 [architect-482] merged 2026-03-26 — network timeouts across packages
- PR #492 [server-dev-483] merged 2026-03-26 — webhook 503 for transient failures
- PR #491 [cli-dev-481] merged 2026-03-26 — anti-injection boundaries + token removal from clone URL
- PR #476 [cli-dev-474] merged 2026-03-26 — gh CLI diff fetch with HTTP fallback
- PR #472 [server-dev-468] merged 2026-03-26 — summary quality gate
- PR #470 [architect-469] merged 2026-03-26 — thinking level field
- PR #467 [server-dev-462] merged 2026-03-26 — summary claim timeout fix
- PR #461 [external/quabug] merged 2026-03-26 — OAuth bugfixes + contributor attribution
