# PM State

## Environments

| Env      | Worker                | Database                              | Deploy                                 |
| -------- | --------------------- | ------------------------------------- | -------------------------------------- |
| **Dev**  | `opencara-worker-dev` | `opencara-dev` (jrufeppapojlsqrtgkcs) | `npx wrangler deploy --env dev`        |
| **Prod** | `opencara-worker`     | `opencara` (nkbkooijcgipdwntjnmq)     | `npx wrangler deploy` (team lead only) |

- **`main` = dev branch** — no separate dev branch
- All feature PRs target `main`; dev worker deployed after each merge
- Production deployment is team-lead-only (version bump + tag)
- **Agents and QA MUST use the dev environment**
- **Production reverted to v0.2.2** — all features after v0.2.2 (v0.7.0, v0.7.1, etc.) are on main/dev only, not yet released to production. Next production release will be a new version bump by team lead.

## Open Issues

- #155 [pm, medium] Replace multi-AI self-review with OpenCara dogfood review — **DONE** (development-workflow.md updated)
- #156 [pm, medium] Auto-deploy dev worker on merge to main (CI/CD)
- #157 [pm, medium] GitHub webhook receiver for event-driven PM — **DONE** (scripts/github-webhook.py created, needs team lead to set up tunnel + settings.local.json)
- #154 [worker-dev+cli-dev, medium] Move diff fetching from worker to agent CLI
- #38 [worker-dev, low] Installation event handlers — project upsert and cleanup
- #80 [cli-dev, low] Growth trends in stats
- #81 [cli-dev, low] Expertise areas in stats
- #90 [worker-dev, low] Dynamic tool/model registry
- #130 [cli-dev, low] Clickable PR links in agent logs
- #133 [design, low] Evaluate migration to Rust or Go
- #144 [design, low] Container-based agent execution
- #162 [design, low] Local Docker dev environment (blocked by #133)
- #164 [worker-dev, medium] Log error codes with agent ID + reduce priority on repeated failures

## Closed Issues (processed)

#1, #3, #4, #5, #8, #9, #11, #13, #14, #18, #19, #20, #24, #25, #26, #27,
#31, #32, #33, #34, #35, #38, #40, #41, #43, #46, #47, #48, #51, #53, #55,
#57, #58, #61, #62, #63, #64, #65, #66, #67, #69, #70, #71, #72, #73,
#80, #81, #82, #83, #84, #85, #86, #87, #88, #90, #95, #96, #99, #100,
#101, #102, #111, #112, #113, #114, #115, #120, #121, #123, #124, #125,
#126, #129, #130, #131, #132, #133, #135, #136,
#145, #146, #147, #148, #159, #160

## Merged PRs (processed)

#2, #6, #7, #10, #12, #15, #16, #17, #21, #22, #23, #28, #29, #30,
#36, #37, #39, #42, #44, #45, #49, #50, #52, #54, #56, #59, #60,
#68, #74, #75, #76, #77, #78, #79, #89, #91, #92, #93, #94, #97,
#103, #104, #105, #106, #107, #108, #109, #110, #116, #117, #118,
#119, #122, #127, #128, #134, #137, #138, #139, #140, #141, #142, #143,
#149, #150, #151, #152, #153, #158, #161, #163
