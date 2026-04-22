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
- #216 [server-dev, medium] Add preferred synthesizer config in .opencara.toml — **DONE** (PR #224 merged)
- #217 [server-dev, medium] Switch from PR Review API to issue comments — **DONE** (PR #218 merged)

### Code review audit (from external reports, 2026-03-21)

- #228 [server-dev, HIGH] Security: .opencara.toml read from PR head branch allows config manipulation — **DONE** (PR #243 merged)
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

### Bug (filed by quabug, 2026-04-14)

- #718 [cli-dev, bug] Private mode should check collaborator access, not just org membership — **DONE** (PR #719 merged)

### Recent activity (2026-04-07 — 2026-04-11)

- #696 [server-dev] Fix eligibility.ts: issue_review role falls through — **DONE** (PR #697 merged)
- #699 [server-dev] Fix status trigger: string-to-object comparison — **DONE** (PR #700 merged)
- #701 [cli-dev] Implement executor default branch detection — **DONE** (PR #702 merged)
- #704 [cli-dev] Implement executor prompt via stdin fix — **DONE** (PR #706 merged)
- #705 [server-dev] Fix spurious implement task creation — **DONE** (PR #712 merged)
- #710 [cli-dev] Implement checkout stale main branch — **DONE** (merged)
- #708 [server-dev] Feature-specific titles for implement/fix — **DONE** (PR #716 merged)
- #698 [cli-dev] Configurable command test timeout — **DONE** (PR #714 merged)

### CI Status (2026-04-13)

- CI failing on main: Prettier format:check fails on 17 docs/ files from commit 9222bb3 (Starlight docs site) — **FIXED** (commit deab4a1 by team lead, CI re-running)

## Closed Issues (processed)

#1, #3, #4, #5, #8, #9, #11, #13, #14, #18, #19, #20, #24, #25, #26, #27,
#31, #32, #33, #34, #35, #38, #40, #41, #43, #46, #47, #48, #51, #53, #55,
#57, #58, #61, #62, #63, #64, #65, #66, #67, #69, #70, #71, #72, #73,
#80, #81, #82, #83, #84, #85, #86, #87, #88, #90, #95, #96, #99, #100,
#101, #102, #111, #112, #113, #114, #115, #120, #121, #123, #124, #125,
#126, #129, #130, #131, #132, #133, #135, #136,
#145, #146, #147, #148, #154, #155, #157, #159, #160, #166, #167, #170,
#173, #174, #175, #176, #177, #178, #179, #180, #181 (dup of #182), #182, #183 (dup of #184), #184, #185, #164, #165, #201, #156, #210, #211, #212, #213, #216, #217, #221, #144, #225, #228, #229, #230, #231, #232, #233, #234, #235, #236, #237, #238, #239, #240, #241, #242, #245, #254, #256, #257, #265, #269, #271, #272, #273, #276, #277, #278, #280, #282, #283, #284, #285, #286, #287, #288, #289, #290, #291, #301, #303, #304, #305, #307, #308, #309, #313, #318, #315, #316, #325, #326, #327, #328, #330, #331, #332, #333, #336, #341, #343, #344, #345, #346, #347, #349, #350, #352, #351, #353, #354, #355, #356, #357, #367, #368, #370, #372, #373, #378, #380, #381, #384, #385, #386, #388, #391, #392, #393, #394, #395, #396, #401, #405, #406, #407, #408, #411, #412, #414, #415, #423, #428, #430, #431, #473, #544, #545, #546, #551, #555, #557, #560, #594, #596, #597, #624, #627, #628, #631, #636, #637, #641, #643, #644, #645, #646, #652, #653, #654, #655, #656, #657, #662, #664, #666, #667, #669, #670, #672, #673, #676, #677, #680, #681, #684, #686, #687, #688, #689, #692, #696, #698, #699, #701, #704, #705, #708, #710, #718, #766, #727, #728, #729, #730, #731, #732, #733, #734, #735, #736, #737, #738, #739, #740, #741, #742, #743, #744, #745, #746, #747, #748, #749, #750, #751, #752, #753, #754, #755, #756, #757, #758, #759, #760, #761, #762, #763, #764, #765, #772

## Merged PRs (processed)

#2, #6, #7, #10, #12, #15, #16, #17, #21, #22, #23, #28, #29, #30,
#36, #37, #39, #42, #44, #45, #49, #50, #52, #54, #56, #59, #60,
#68, #74, #75, #76, #77, #78, #79, #89, #91, #92, #93, #94, #97,
#103, #104, #105, #106, #107, #108, #109, #110, #116, #117, #118,
#119, #122, #127, #128, #134, #137, #138, #139, #140, #141, #142, #143,
#149, #150, #151, #152, #153, #158, #161, #163, #168, #169, #171, #172, #186, #187, #188, #189, #190, #191, #192, #193, #194, #195, #197, #198, #196, #199, #200, #202, #203, #204, #205, #206, #207, #208, #209, #214, #215, #218, #219, #220, #222, #223, #224, #226, #227, #243, #244, #246, #247, #248, #249, #250, #251, #252, #253, #255, #258, #260, #261, #263, #264, #266, #267, #268, #270, #274, #275, #279, #281, #292, #293, #294, #295, #296, #297, #298, #299, #300, #306, #310, #311, #312, #314, #317, #319, #320, #322, #324, #329, #334, #335, #337, #338, #339, #340, #342, #358, #359, #360, #361, #362, #363, #364, #365, #366, #369, #371, #374, #375, #376, #379, #382, #383, #387, #389, #390, #398, #399, #400, #402, #416, #417, #418, #419, #420, #421, #422, #425, #426, #429, #528, #529, #532, #533, #538, #539, #540, #542, #543, #547, #548, #549, #550, #552, #558, #559, #562, #563, #571, #572, #573, #575, #579, #582, #583, #584, #585, #586, #587, #588, #589, #590, #591, #592, #595, #598, #599, #604, #605, #606, #607, #625, #626, #629, #630, #632, #633, #634, #635, #638, #639, #642, #647, #648, #649, #650, #651, #658, #659, #660, #661, #663, #665, #668, #671, #683, #685, #690, #691, #693, #694, #695, #697, #700, #702, #706, #712, #714, #715, #716, #717, #719, #720, #721, #722, #723, #724, #725, #726, #768

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

- #423 [server-dev, P2, M] Add model/tool constraint for synthesizer in .opencara.toml — **BACKLOG**
- #424 [architect, P1, L] Reorganize .opencara.toml into modular feature sections (v2 config) — **BACKLOG**
- #427 [cli-dev, P2, S] Add --verbose mode to log tool stdout/stderr — **IN REVIEW** (PR #573 merged 2026-03-28, QA pending)
- #428 [architect, P2, S] Add amp to tool registry and update contributor docs — **BACKLOG** (deferred — amp -x requires paid credits, 402 error, closed)
- #430 [pm, P3, XS] Update docs to use canonical tool names from registry — **DONE** (agent-guide.md claude-code→claude)
- #431 [pm, P2, M] Improve local-agent.md as comprehensive contributor guide — **DONE** (commit 5042484, closed)

### Dedup Feature (2026-03-25)

#### PR Dedup

- #432 [architect, P1, M] Add dedup+triage roles to shared types and .opencara.toml parser — **BACKLOG** (blocks all dedup and triage issues)
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
- #473 [cli-dev, P2, M] CLI: persistent repo cache with git worktrees for review checkouts — **DONE** (PR #563 merged 2026-03-28, QA PASS, board→Done, closed)
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

### Dedup/Triage improvements (2026-03-27)

- #525 [server-dev, P2, M] Dedup index issue: structured 3-comment layout with lifecycle categories — **DONE** (PR #528 merged, QA PASS 2026-03-27)
- #526 [architect, P2, M] Split dedup/triage TaskRole into pr/issue variants — **DONE** (PR #529 merged, QA PASS 2026-03-27)
- ~~#527~~ — **CLOSED** (duplicate of #526, getTaskRole bug subsumed by TaskRole split)

### New features (2026-03-27)

- #530 [cli-dev, P2, M] CLI command to initialize dedup index by scanning existing PRs/issues — **DONE** (PR #532 merged, QA PASS 2026-03-27)
- #531 [server-dev, P1, S] Serialize dedup tasks per repo — only one claimable at a time — **DONE** (PR #533 merged, QA PASS 2026-03-27)
- #534 [server-dev, P2, M] Maintain dedup index lifecycle — move entries on PR close and age-out — **DONE** (PR #543 merged, QA PASS 2026-03-27)

### Bug fixes (live QA, 2026-03-27)

- #535 [cli-dev, P1, S] Dedup report parser too strict — rejects string numbers from LLM output — **DONE** (PR #538 merged, QA PASS 2026-03-27)
- #536 [server-dev, P1, S] Multi-agent review only creates 1 task instead of agent_count-1 — **DONE** (PR #539 merged, QA PASS 2026-03-27)
- #537 [server-dev, P1, M] Issue webhook not creating dedup/triage tasks — **DONE** (PR #540 merged, QA PASS 2026-03-27)
- #541 [cli-dev, P1, S] CLI crashes on issue tasks — diff fetch fails for triage/dedup with pr_number=0 — **DONE** (PR #542 merged, QA PASS 2026-03-27)

### User-requested (2026-03-27)

- #544 [cli-dev, P2, S] Change dedup index entry format to NUMBER(LABELS): DESCRIPTION — **DONE** (PR #548 merged 2026-03-27)
- #545 [cli-dev, P2, M] dedup init: allow choosing AI agent/tool for index entry generation — **DONE** (PR #549 merged 2026-03-27)

### Bug: dedup/triage custom prompt gap (2026-03-27)

- #546 [cli-dev, P1, S] Wire repo custom prompt into dedup and triage prompt builders — **DONE** (PR #547 merged 2026-03-27)

### Cleanup (2026-03-28)

- PR #550 [external/quabug] merged 2026-03-28 — Remove unused api_key auth from CLI config (no issue)

### Bug fix (user-reported, 2026-03-28)

- #551 [server-dev, P1, S] Summary task not claimed after all reviews complete — D1 race in result handler — **DONE** (PR #552 merged 2026-03-28, 1941 tests passing)

### New features (2026-03-28)

- #553 [cli-dev, P2, M] Auto-cleanup cloned codebase repos after task completion or timeout — **DONE** (PR #572 merged 2026-03-28, QA PASS, board→Done, closed)
- #554 [server-dev, P2, M] Prefer model diversity across all tasks in a group — **DONE** (PR #571 merged 2026-03-28, QA PASS, board→Done, closed)
- #555 [server-dev, P2, S] Add preferred_models support for summarizer config — **DONE** (PR #558 merged 2026-03-28, In Review for QA)

### Bug (QA-discovered, 2026-03-28)

- #557 [cli-dev, P1, S] Repo filter mode rename breaks backward compatibility — **DONE** (PR #559 merged 2026-03-28, In Review for QA)

### Bug (user-reported, 2026-03-28)

- #560 [cli-dev, P1, S] Keep heartbeat alive during review execution to prevent claim reclaim — **DONE** (PR #562 merged 2026-03-28, In Review for QA)

### Implementation/Fix Feature — Epic #564 (2026-03-28)

Parent: #564 — CLI Agent Implementation/Fix Mode

| #    | Title                                                     | Agent      | Status    | PR   |
| ---- | --------------------------------------------------------- | ---------- | --------- | ---- |
| #566 | Add implement/fix types to shared package                 | architect  | Done      | #584 |
| #574 | Fixed permission rules for implement/fix triggers         | architect  | In Review | #591 |
| #567 | Handle PR comment /opencara fix for fix tasks             | server-dev | In Review | #586 |
| #568 | Handle `/opencara go` comment trigger for implement tasks | server-dev | In Review | #588 |
| #569 | Implement task executor — issue to branch to AI to PR     | cli-dev    | In Review | #590 |
| #570 | Fix task executor — PR comments to AI to push             | cli-dev    | In Review | #589 |

**STATUS: CODE-COMPLETE** — All 7 code issues merged (PRs #584, #586, #588, #589, #590, #591). QA deferred per team-lead.

### Dispatch queue

**In Review** (merged, QA pending):

- #567 Handle /opencara fix — PR #586 merged, **CLOSED** 2026-03-30
- #568 Handle /opencara go — PR #588 merged, **CLOSED** 2026-03-30
- #569 Implement task executor — PR #590 merged, **CLOSED** 2026-03-30
- #570 Fix task executor — PR #589 merged, **CLOSED** 2026-03-30
- #574 Fixed permission rules — PR #591 merged, **CLOSED** 2026-03-30
- #581 Store PR diff size — PR #592 merged, **CLOSED** 2026-03-30
- #564 CLI Agent Implementation/Fix Mode (epic) — ALL sub-issues merged, **CLOSED** 2026-03-30

**Ready** (awaiting dispatch):

- (none)

**Done** (closed, QA skipped per team-lead):

- #577 Auth file path config — PR #585 merged, board→Done, closed
- #580 Share git worktree across tasks — PR #587 merged, board→Done, closed

### Bug fixes (2026-03-29/30)

- #594 [server-dev, P1, S] taskRoleSchema missing 'implement' and 'fix' enum values — **DONE** (PR #595 merged 2026-03-30, closed)
- #596 [server-dev, P1, M] Summary result handler missing implement/fix cases — **DONE** (PR #599 merged 2026-03-30)
- #597 [cli-dev, P2, S] Default agent roles missing implement and fix — **DONE** (PR #598 merged 2026-03-30)

### #593 Redesign CLI agent polling: batch poll, permission check, OAuth-only

Parent: #593 — broken down 2026-03-30

| Phase | #    | Title                                        | Agent      | Status         | Blocked by |
| ----- | ---- | -------------------------------------------- | ---------- | -------------- | ---------- |
| 1     | #600 | Remove API key auth — OAuth-only             | server-dev | DONE (PR #606) | —          |
| 2a    | #601 | Add BatchPoll types to shared package        | architect  | DONE (PR #604) | —          |
| 2b    | #602 | Add POST /api/tasks/poll/batch endpoint      | server-dev | DONE (PR #605) | #601       |
| 2c+3  | #603 | Batch poll coordinator and repo access check | cli-dev    | DONE (PR #607) | —          |

**ALL 4 SUB-ISSUES COMPLETE.** #593 redesign fully implemented and merged (2026-03-30). PRs: #604, #605, #606, #607. Parent issue #593 **CLOSED** 2026-03-30. QA pending.

### Closed (2026-03-28)

- #423 [server-dev, P2, M] Add model/tool constraint for synthesizer — **CLOSED** (superseded by #555)

### QA results (2026-03-28)

- #551 — QA PASS (PR #552 merged, board → Done, issue closed)
- #555 — QA PASS (PR #558, 6+ new tests, backward compatible)
- #557 — QA PASS (PR #559, alias mapping + deprecation warning, 2 new tests)
- #560 — QA PASS (PR #562, threshold 3→10min, heartbeat on claim/result, 6+ new tests)
- #473 — QA PASS (PR #563, 1989 tests, repo-cache.ts 100% coverage, all 8 acceptance criteria verified, issue closed)
- #553 — QA PASS (PR #572, board→Done, closed)
- #554 — QA PASS (PR #571, board→Done, closed)

Note: Smoke test now PASS — bot posted 2 timeout comments on opencara-dev-test#68, confirming full pipeline. Previous AUTH_TOKEN_REVOKED issue resolved.

### Post-M21 QA (2026-04-05)

- #652 [qa] Post-M21 QA Verification (PRs #575–#651) — **DONE** (44/44 PASS, all green, closed)

### OAuth token fix (2026-03-31)

- #624 [server-dev, P1] Remove artificial 8-hour token expiry for OAuth App tokens — **DONE** (PR #625, PR #626 merged)

### Unified trigger config (2026-04-01)

- #627 [architect, P1] Unify trigger config across all features — **DONE** (PR #629 merged)
- #628 [server-dev, P1] Handle unified trigger modes in webhook handlers — **DONE** (PR #630 merged)
- #631 [server-dev, P1] Fix preferred_models grace period baseline for summary tasks — **DONE** (PR #632 merged)

### Bug fixes (2026-04-01)

- PR #633 [direct] Fix summary task repo filter for private mode agents — **DONE**
- PR #634 [direct] Fix preferred review round-robin fair distribution — **DONE**
- PR #635 [direct] Shuffle agent order in batch poll for fair task distribution — **DONE**

### Bug fixes / improvements (2026-04-02)

- #636 [cli-dev, P1] Fix dedup init to use gh CLI instead of platform OAuth token — **DONE** (PR #639 merged)
- #637 [server-dev, P2] Update dedup index entries on PR/issue title and label changes — **DONE** (PR #638 merged)

### Bug fixes / improvements (2026-04-04)

- #641 [server-dev, P1] Zombie issue tasks with pr_number=0 block dedup serialization — **DONE** (PR #642 merged)
- #643 [server-dev, P2] Clean up pending tasks when PR is merged or closed — **DONE** (PR #647 merged)
- #644 [cli-dev, P3] Display version and commit hash on CLI launch — **DONE** (PR #649 merged)
- #645 [cli-dev, P2] Display enabled features of each agent tool on CLI launch — **DONE** (PR #649 merged)
- #646 [cli-dev, P2] Auto-build dedup context from GitHub API — **DONE** (PR #648 merged)

### Prompt/review refactoring (2026-04-05)

- PR #650 [direct] Share prompt blocks across review modes, compact for multi-agent — **DONE**
- PR #651 [direct] Post review verdict as GitHub review event — **DONE**

### M22: Reputation System (2026-04-06)

- #653 [breakdown] Emoji reaction-based reputation system with account-level blocking — **DONE** (all sub-issues merged)
  - #654 [server-dev, P1] Revert to issue comment posting + capture comment ID — **DONE** (PR #658 merged)
  - #655 [server-dev, P1] D1 migration + DataStore methods + reputation constants — **DONE** (PR #659 merged)
  - #656 [server-dev, P1] Reputation module — Wilson score, decay, multipliers, reaction collection — **DONE** (PR #660 merged)
  - #657 [server-dev, P1] Eligibility integration — reputation multipliers + account-level blocking — **DONE** (PR #661 merged)

### Bug fixes (2026-04-06)

- #662 [server-dev, P1] Batch poll rate limit blocks multiple CLI instances from same IP — **DONE** (PR #663 merged)
- #664 [cli-dev, P1] CLI agent process doesn't terminate on SIGTERM — zombie processes — **DONE** (PR #665 merged)

### Configurable Named Agents (2026-04-07)

#### Implement agents

- #666 [architect, P2, M] Add named agent definitions to implement config types and parser — **DONE** (PR #668 merged 2026-04-07, board→Done, closed)
- #667 [server-dev, P2, S] Resolve named agent ID in /opencara go command — **DONE** (PR #671 merged 2026-04-07, board→Done, closed)

#### Fix agents

- #669 [architect] — **CLOSED** (round 1, created without approval)
- #670 [server-dev] — **CLOSED** (round 1, created without approval)
- #672 [architect] Add named agent definitions to fix config types and parser — **DONE** (PR #674 merged 2026-04-07)
- #673 [server-dev] Resolve named agent ID in /opencara fix command — **DONE** (PR #675 merged 2026-04-07)

### Triage bugs (external repo, 2026-04-07)

- #676 [cli-dev, HIGH] Triage prompt hardcoded to OpenCara's monorepo structure — **DONE** (PR #678 merged 2026-04-07)
- #677 [server-dev, HIGH] Triage comment missing proper header and contributor info — **DONE** (PR #679 merged 2026-04-07)

### Project field as agent ID selector (2026-04-07)

- #680 [architect, HIGH] Add agent_field config to implement and fix sections — **DONE** (PR merged, prerequisite for #681)
- #681 [server-dev, HIGH] Resolve agent ID from project board field for implement/fix tasks — **DONE** (PR #683 merged 2026-04-07)

### Observability (2026-04-07)

- #684 [server-dev, HIGH] Add structured logging to webhook handler critical paths — **DONE** (PR #685 merged 2026-04-07)

### Issue Review Feature (2026-04-07)

- #686 [architect, HIGH] Add issue_review types, config, and TOML parser — **DONE** (PR #690 merged 2026-04-07)
- #687 [server-dev, HIGH] Handle issue review triggers in webhook handler — **DONE** (PR #693 merged 2026-04-07)
- #688 [cli-dev, HIGH] Issue review executor and prompt builder — **DONE** (PR #691 merged 2026-04-07)
- #689 [server-dev, HIGH] Handle issue review result synthesis and posting — **DONE** (PR #695 merged)

### Issue Review Feature hardening (2026-04-07)

- #696 [server-dev, HIGH] Fix eligibility.ts: issue_review role falls through to summarizer rules — **DONE** (PR #697 merged)

### Workflow migration: implement-based agents (2026-04-07)

- Replaced team-system dev agents with OpenCara implement feature (dogfooding)
- Deleted: architect.md, server-dev.md, cli-dev.md, qa.md from .claude/agents/
- Updated: .opencara.toml, pm.md, agent-workflow.md, development-workflow.md, CLAUDE.md
- New dispatch: PM sets Agent field → moves to In progress → status trigger creates implement task
- Committed directly to main (doc-only changes)

### Status trigger bug (2026-04-07)

- #699 [server-dev, CRITICAL] Fix status trigger: string-to-object comparison never matches — **DONE** (PR #700 merged)

### CLI improvements (2026-04-07)

- #698 [cli-dev, LOW] Make command test timeout configurable in config.toml — **READY** (PR #707 closed — stale main/conflicts, will re-trigger after prod deploy)

### Feature request (2026-04-02)

- #640 [breakdown, P2, L] Add `opencara review <pr-link>` CLI command with user-posted results — **BACKLOG** (user-created, needs breakdown before dispatch)

### Bare clone bug (2026-04-07)

- #701 [cli-dev, CRITICAL] Implement executor fails to detect default branch in bare clone — **DONE** (PR #702 merged 2026-04-07)

### Coordinator feature (2026-04-07)

- #703 [breakdown, P2, L] Add coordinator feature — configurable task orchestration in .opencara.toml — **BACKLOG** (needs design finalization + breakdown before dispatch)

### Implement executor bug (2026-04-07)

- #704 [cli-dev, CRITICAL] Implement executor: prompt delivered via stdin instead of -p argument — **DONE** (PR #706 merged 2026-04-07)

### Spurious task creation bug (2026-04-07)

- #705 [server-dev, HIGH/CRITICAL] Spurious implement task creation for non-In-Progress issues — **DONE** (PR #712 merged 2026-04-07, board→Done, closed)
  - Spurious PRs closed: #709 (for #708), #711 (for #710)

### Feature-specific titles (2026-04-07)

- #708 [server-dev, HIGH] Implement/fix results and timeouts should use feature-specific titles — **BACKLOG**

### Stale main in bare clone (2026-04-07)

- #710 [cli-dev, HIGH] Implement checkout creates branch from stale main in bare clone — **BACKLOG** (added to board 2026-04-07)

### Bug fix (2026-04-07)

- #692 [server-dev, HIGH] Assign per-task preferred model instead of shared preference list — **DONE** (PR #694 merged 2026-04-07)

### Critical bug — worktree FETCH_HEAD (2026-04-20, team-lead direct)

- #766 [cli-dev, priority:high, bug] Fix worktree reuse: FETCH_HEAD not resolvable in worktree context, second+ PR polls fail — **DONE** (PR #768 merged 2026-04-22T10:24:42Z, commit b88ee82. Team-lead direct-merged, bot review skipped — bug was blocking a live agent (Claude Opus#1 hit the same pathspec error ~3 min before merge). Board moved In-review→Done, issue closed by PM.) Implementation: `resolveFetchedPrCommit` helper does `git rev-parse --verify FETCH_HEAD` in bare repo for a stable SHA; threads into `addWorktree(bareRepoPath, wtKey, targetRef)` and replaces `git checkout --detach --force FETCH_HEAD` with `... <sha>`. Functionally equivalent to the refspec approach originally proposed in the issue.
- #767 [cli-dev, priority:low] Improve 404 diff-fetch hint — don't blame auth when user is authenticated — **BACKLOG** (scope refreshed 2026-04-22 — post-#726 the HTTP 404 path is a fallback-of-a-fallback; auth-branching fix is still valid but narrower than the original spec. See issue comments 4294957609 + 4295071228 for updated acceptance criteria).

### Proactive finding (2026-04-22, PM idle review)

- #773 [server-dev, priority:low, enhancement] Prune unbounded `agent_reliability_events` (and optionally `reputation_events`) rows in scheduled cleanup — **BACKLOG**. Rooted in PR #724's new table that's append-only with a 30-min query window: rows older than `RELIABILITY_WINDOW_MS` are never read, never deleted. Same latent issue on `reputation_events` (14-day half-life decay → weight at 180d is ~0.00014). Fix: add `cleanupStaleReliabilityEvents` to the scheduled hook next to existing `cleanupTerminalTasks` / `cleanupExpiredOAuthCache`. Reputation prune is optional follow-up; issue body specifies both as one bundle since the pattern is identical.
- #774 [cli-dev, priority:low, enhancement] Flaky test: `cli-server-integration 'tool crash reports error to server, slot is freed'` hits 15s timeout under load — **BACKLOG**. Observed 2026-04-22 during M23-shelve docs gate (1 failure first run, passed in isolation at 13.6s and full-suite retry 2927/2927). Typical ~13–14s vs 15s deadline leaves ~1s headroom. Recommended fix: add `{ timeout: 30000 }` to the `it(...)` (2-char change, zero risk). Fallback: slim test body. Not a functional bug.

### Epic: opencara-relay-cli (#640 breakdown, 2026-04-22)

- #640 [breakdown, epic:review-cli, enhancement] `opencara review <pr-link>` CLI command — **BREAKDOWN** (parent stays Backlog; 3 sub-issues created, all start in Backlog per team-lead; will promote when ready)
  - #769 [architect, P2, S] Shared types (`cli_triggered`, `TriggerReviewRequest/Response`, `ReviewGroupStatus`) + D1 migration — blocks #770, #771
  - #770 [server-dev, P2, M] `/api/reviews/trigger` + `/status` endpoints + suppress bot posting — **blocked by #769**
  - #771 [cli-dev, P2, M] `opencara review <pr-link>` command implementation — **blocked by #769** (can scaffold in parallel with #770)

### Shelved: opencara-relay epic (2026-04-22, team-lead decision)

- **M23 SHELVED.** Epic #727 + all 38 sub-issues (#728–#765) + E2E smoke test #772 closed as `not planned`. All 40 items moved to Done on the project board. Design doc retained at `.claude/designs/opencara-relay.md`; `epic:relay` label kept for archival. Decision final — no clarifier needed. Closed items (in order R1..R31 + R15a + E2E): #727 (epic), #728, #729, #730, #731, #732, #733, #734, #735, #736, #737, #738, #739, #740, #741, #742, #743, #744, #745, #746, #747, #748, #749, #750, #751, #752, #753, #754, #755, #756, #757, #758, #759, #760, #761, #762, #763, #764, #765, #772 — all `[closed: shelved M23]`.

## Open PRs

(none)

## Merged PRs (pending processing)

(none — all caught up through #726 as of 2026-04-22)

## Recently processed

- npm publish: **opencara@0.24.3** published 2026-04-22 via publish-cli.yml workflow run 24779594261 (conclusion=success). CLI patch release for the #766 FETCH_HEAD fix. Tag `v0.24.3`, commit `c08a9b3`.
- PR #768 [direct/quabug, b88ee82] merged 2026-04-22T10:24:42Z — fix(cli): resolve FETCH_HEAD in bare repo for worktree reuse (#766 DONE, bot review skipped due to live-agent breakage)
- PR #726 [direct/quabug] merged 2026-04-20 — feat(cli): prefer local git diff when PR worktree available (fixes 404 cascade on 300+-file PRs, ties into #766 follow-up)
- PR #725 [direct/quabug] merged 2026-04-20 — fix(server): key batch-poll weight by agent_id, skip zero-weight agents (completes #724 reliability system)
- PR #724 [direct/quabug] merged 2026-04-20 — feat(server): per-agent reliability + weighted-random dispatch (migration 0018, agent_reliability_events table, fixes stuck-Codex loop on ParadiseEngine#29)
- PR #723 [direct/quabug] merged 2026-04-18 — feat: model-family matching for preferred_models and target_model (modelMatchesPattern helper, decouples config from version bumps)
- PR #722 [direct/quabug] merged 2026-04-18 — fix: include claude-opus-4-7 in summarizer preferred_models (interim config patch, long-term replaced by #723)
- PR #721 [direct/quabug] merged 2026-04-18 — fix(cli): passive weight recovery and dedupe paused agent logs (30-min recovery for weight<0.1, one-log-per-pause)
- PR #720 [direct/quabug] merged 2026-04-15 — fix: log filtered tasks and bypass diff limit for explicit repos (diagnostics + bidirectional @/slash trigger matching)
- PR #712 [server-dev] merged 2026-04-07 — Fix spurious implement task creation (#705)
- PR #706 [cli-dev] merged 2026-04-07 — Fix implement executor prompt delivery via -p (#704)
- PR #702 [cli-dev] merged 2026-04-07 — Fix bare clone default branch detection (#701)
- PR #700 [server-dev] merged 2026-04-07 — Fix status trigger string-to-object comparison (#699)
- PR #697 [server-dev] merged 2026-04-07 — Fix eligibility.ts issue_review fallthrough (#696)
- PR #695 [server-dev] merged 2026-04-07 — Issue review result synthesis and posting (#689)
- PR #694 [server-dev] merged 2026-04-07 — Per-task preferred model assignment (#692)
- PR #691 [cli-dev] merged 2026-04-07 — Issue review executor and prompt builder (#688)
- PR #693 [server-dev] merged 2026-04-07 — Handle issue review triggers in webhook (#687)
- PR #690 [architect] merged 2026-04-07 — Add issue_review types, config, TOML parser (#686)
- PR #685 [server-dev] merged 2026-04-07 — Add structured logging to webhook critical paths (#684)
- PR #683 [server-dev] merged 2026-04-07 — Resolve agent ID from project board field (#681)
- PR #682 [architect] merged 2026-04-07 — Add agent_field config to implement and fix sections (#680)
- PR #679 [server-dev] merged 2026-04-07 — Triage comment header + contributor info (#677)
- PR #678 [cli-dev] merged 2026-04-07 — Generic triage prompt (#676)
- PR #675 [server-dev] merged 2026-04-07 — Resolve named agent ID in /opencara fix command (#673)
- PR #674 [architect] merged 2026-04-07 — Add named agent definitions to fix config types and parser (#672)
- PR #671 [server-dev] merged 2026-04-07 — Resolve named agent ID in /opencara go command (#667)
- PR #668 [architect] merged 2026-04-07 — Add named agent definitions to implement config types and parser (#666)
- PR #665 [cli-dev] merged 2026-04-06 — Fix SIGTERM/SIGINT handlers to prevent zombie processes (#664)
- PR #663 [server-dev] merged 2026-04-06 — Rate limit batch poll by authenticated identity (#662)
- PR #661 [server-dev] merged 2026-04-06 — Eligibility integration — reputation multipliers (#657)
- PR #660 [server-dev] merged 2026-04-06 — Reputation module — Wilson score, decay (#656)
- PR #659 [server-dev] merged 2026-04-06 — D1 migration + DataStore reputation methods (#655)
- PR #658 [server-dev] merged 2026-04-06 — Revert to issue comment posting (#654)
- PR #651 [direct] merged 2026-04-05 — Post review verdict as GitHub review event
- PR #650 [direct] merged 2026-04-05 — Share prompt blocks across review modes
- PR #649 [cli-dev] merged 2026-04-04 — Display version/commit hash and tool features (#644, #645)
- PR #648 [cli-dev] merged 2026-04-04 — Auto-build dedup context from GitHub API (#646)
- PR #647 [server-dev] merged 2026-04-04 — Clean up pending tasks on PR/issue close (#643)
- PR #642 [server-dev] merged 2026-04-04 — Fix zombie issue tasks and dedup namespace (#641)
- PR #639 [cli-dev] merged 2026-04-02 — Fix dedup init to use gh CLI (#636)
- PR #638 [server-dev] merged 2026-04-02 — Update dedup index entries on title/label changes (#637)
- PR #635 [direct] merged 2026-04-01 — Shuffle agent order in batch poll
- PR #634 [direct] merged 2026-04-01 — Preferred review round-robin fair distribution
- PR #633 [direct] merged 2026-04-01 — Summary task repo filter for private mode agents
- PR #632 [server-dev] merged 2026-04-01 — Fix preferred_models grace period baseline (#631)
- PR #630 [server-dev] merged 2026-04-01 — Handle unified trigger modes (#628)
- PR #629 [architect] merged 2026-04-01 — Unify trigger config across features (#627)
- PR #626 [server-dev] merged 2026-03-31 — Remove expires_in/expires_at for OAuth tokens (#624)
- PR #625 [server-dev] merged 2026-03-31 — Remove 8-hour token expiry (#624)
- PR #595 [bug] merged 2026-03-30 — Fix: add implement and fix to taskRoleSchema (#594)
- PR #592 [server-dev] merged 2026-03-29 — Store PR diff size on task (#581)
- PR #591 [architect] merged 2026-03-29 — Fixed permission rules for implement/fix triggers (#574)
- PR #590 [cli-dev] merged 2026-03-29 — Implement task executor (#569)
- PR #589 [cli-dev] merged 2026-03-29 — Fix task executor (#570)
- PR #588 [server-dev] merged 2026-03-29 — Handle /opencara go comment trigger (#568)
- PR #587 [cli-dev] merged 2026-03-29 — Share git worktree across tasks for same PR (#580)
- PR #586 [server-dev] merged 2026-03-28 — Handle /opencara fix trigger (#567)
- PR #585 [cli-dev] merged 2026-03-28 — Add auth file path config for per-environment auth (#577)
- PR #584 [architect] merged 2026-03-28 — Add implement/fix types to shared package (#566)
- PR #583 [cli-dev] merged 2026-03-28 — Fix auth login re-auth prompt (#576)
- PR #582 [external/quabug] merged 2026-03-28 — fix: use gh CLI for org membership fetch
- PR #579 [cli-dev] merged 2026-03-28 — Fix private repo filter mode (#578)
- PR #575 [cli-dev] merged 2026-03-28 — Add multi-instance agent option (#565)
- PR #573 [cli-dev] merged 2026-03-28 — Add --verbose mode for debugging (#427)
- PR #572 [cli-dev] merged 2026-03-28 — Auto-cleanup cloned codebase repos (#553)
- PR #571 [server-dev] merged 2026-03-28 — Prefer model diversity across all tasks in a group (#554)
- PR #563 [cli-dev] merged 2026-03-28 — Persistent repo cache with git worktrees (#473)
- PR #562 [cli-dev] merged 2026-03-28 — Keep heartbeat alive on claim/result (#560)
- PR #558 [server-dev] merged 2026-03-28 — Add preferred_models support for summarizer config (#555)
- PR #559 [cli-dev] merged 2026-03-28 — Backward-compatible aliases for repo filter modes (#557)
- PR #552 [server-dev-551] merged 2026-03-28 — Fix race condition in summary task creation (#551)
- PR #550 [external/quabug] merged 2026-03-28 — Remove unused api_key auth from CLI config
- PR #549 [cli-dev] merged 2026-03-27 — dedup init agent/tool selection (#545)
- PR #548 [cli-dev] merged 2026-03-27 — Change dedup index entry format (#544)
- PR #547 [cli-dev] merged 2026-03-27 — Wire repo custom prompt into dedup/triage (#546)
- PR #543 [server-dev] merged 2026-03-27 — Dedup index lifecycle (#534)
- PR #542 [cli-dev] merged 2026-03-27 — Fix CLI crash on issue tasks (#541)
- PR #540 [server-dev] merged 2026-03-27 — Fix issue webhook not creating dedup/triage tasks (#537)
- PR #539 [server-dev] merged 2026-03-27 — Fix D1 createTaskIfNotExists blocking multi-task groups (#536)
- PR #538 [cli-dev] merged 2026-03-27 — Fix dedup report parser string number coercion (#535)
- PR #533 [server-dev] merged 2026-03-27 — Serialize dedup tasks per repo (#531)
- PR #532 [cli-dev] merged 2026-03-27 — CLI command to initialize dedup index (#530)
- PR #529 [architect] merged 2026-03-27 — Split dedup/triage TaskRole into pr/issue variants (#526)
- PR #528 [server-dev] merged 2026-03-27 — Structured 3-comment dedup index layout (#525)

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
