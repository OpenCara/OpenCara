# OpenCara Roadmap

## Recent Activity

- **2026-07-30**: Merged [#199](https://github.com/OpenCara/OpenCara/pull/199) - fix(ci): drop --provenance from publish-cli (repo is private)
- **2026-07-30**: Merged [#198](https://github.com/OpenCara/OpenCara/pull/198) - fix(cli): accept dot-separated GitHub installation tokens in worktree create
- **2026-07-18**: Merged [#197](https://github.com/OpenCara/OpenCara/pull/197) - docs(readme): refresh for ACP cutover + new-user onboarding section
- **2026-07-06**: Merged [#192](https://github.com/OpenCara/OpenCara/pull/192) - fix(claude-acp): advertise the model as an ACP config option
- **2026-07-02**: Merged [#191](https://github.com/OpenCara/OpenCara/pull/191) - fix(flows): stop synthesizer stub reviews from reaching GitHub
- **2026-07-02**: Merged [#189](https://github.com/OpenCara/OpenCara/pull/189) - Install release-deploy workflow + graceful shutdown for supervised runtime
- **2026-07-02**: Merged [#188](https://github.com/OpenCara/OpenCara/pull/188) - Host protocol version handshake + tolerant frame parsing
- **2026-07-02**: Merged [#186](https://github.com/OpenCara/OpenCara/pull/186) - Week-one safety fixes: working cancellation, job timeouts, fail-closed config, chat token scrub, tests in CI
- **2026-07-01**: Merged [#184](https://github.com/OpenCara/OpenCara/pull/184) - feat(acp): select agent model over ACP session/set_config_option

## Completed

- [x] docs(readme): refresh for ACP cutover + new-user onboarding section ([#197](https://github.com/OpenCara/OpenCara/pull/197))
- [x] fix(claude-acp): advertise the model as an ACP config option ([#192](https://github.com/OpenCara/OpenCara/pull/192))
- [x] fix(flows): stop synthesizer stub reviews from reaching GitHub ([#191](https://github.com/OpenCara/OpenCara/pull/191))
- [x] Install release-deploy workflow + graceful shutdown for supervised runtime ([#189](https://github.com/OpenCara/OpenCara/pull/189))
- [x] Host protocol version handshake + tolerant frame parsing ([#188](https://github.com/OpenCara/OpenCara/pull/188))
- [x] Week-one safety fixes: working cancellation, job timeouts, fail-closed config, chat token scrub, tests in CI ([#186](https://github.com/OpenCara/OpenCara/pull/186))
- [x] feat(acp): select agent model over ACP session/set_config_option ([#184](https://github.com/OpenCara/OpenCara/pull/184))
- [x] feat(agents): editable ACP adapter args override (kind-fixed command) ([#183](https://github.com/OpenCara/OpenCara/pull/183))
- [x] fix(agents): translate model selection per ACP adapter (codex/opencode) ([#181](https://github.com/OpenCara/OpenCara/pull/181))
- [x] fix(auth): coalesce+cache session lookups; SPA recovers from 503 ([#180](https://github.com/OpenCara/OpenCara/pull/180))
- [x] Development-lifecycle multi-agent review + dispatch/pooler reliability fixes ([#165](https://github.com/OpenCara/OpenCara/pull/165))
- [x] fix(cli): accept dot-separated GitHub installation tokens in worktree create ([#198](https://github.com/OpenCara/OpenCara/pull/198))
- [x] fix(ci): drop --provenance from publish-cli (repo is private) ([#199](https://github.com/OpenCara/OpenCara/pull/199))

## In Progress

### Azure DevOps support

Landed:

- [x] Platform-neutral flow node kinds (`github.*` → `scm.*`, old spellings still accepted on read) + `ScmProvider` seam
- [x] Schema: `azure_devops_connections`, `user_identities`, per-platform project columns (migrations 0042–0044)
- [x] Microsoft Entra sign-in
- [x] Connect an organization, list + add repositories, create service hook subscriptions
- [x] Authenticate and record inbound service hook deliveries
- [x] Azure DevOps action provider (PR thread + reviewer vote, comment, labels)
- [x] CLI `worktree create --clone-url / --auth-user`, `OPENCARA_SCM_TOKEN`

- [x] Flow engine accepts Azure DevOps projects; `PlatformRunCtx` threads platform identity through `NodeRunCtx`
- [x] Azure DevOps token minting + `--clone-url` / `--auth-user` at worktree allocation
- [x] `OPENCARA_*` run context from Azure DevOps payloads (same variable names, plus `OPENCARA_PLATFORM`)
- [x] Dispatch flows from Azure DevOps deliveries; engine starts with no GitHub App configured
- [x] Azure DevOps variant of the issue-implement contract skill (`az repos pr` instead of `gh pr`)

Remaining:

- [ ] Boards / kanban parity: work item mirroring, `scm.board_item` trigger from `workitem.updated`. Work item events are received and recorded but drive nothing.
  - Blocker to resolve first: a work item event carries only the team project, so `resolveProject` in `webhooksAzure.ts` matches every OpenCara project under that team project and `.limit(1)` picks an arbitrary one. Harmless while these events drive nothing; board mirroring must key on the work item's linked repository or an explicit board↔project link.
- [ ] Inline PR diffs for Azure DevOps agents. There is no single unified-diff endpoint, so `stdin.diff` is empty and `OPENCARA_PR_DIFF_INLINE=0`; agents must `git diff` in the worktree. Reviewer flows *without* a worktree get no diff at all.
- [ ] Azure DevOps equivalents for the features currently skipped-with-a-log: auto-merge (`autoCompleteSetBy` + branch policies), PR↔work-item linking, draft-PR ready-for-review
- [ ] Device capability gating (`scm.azure_devops`). `pickIdle` ignores capabilities entirely — a pre-existing bug. Today a device on an older CLI fails an Azure DevOps worktree allocation with an "unknown argument" error, which is visible but not routed around.
- [ ] Default the review→fix reviewer filter to the connection's user (no `opencara[bot]` identity on Azure DevOps, so the default filter never matches)
- [ ] Azure DevOps variants of the remaining `gh`-based skill prompts (`projectPm`, `projectDetail`, `flowRunStepChat`)

## Planned

<!-- Future work items go here -->
