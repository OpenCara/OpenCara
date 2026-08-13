# OpenCara Roadmap

## Recent Activity

- **2026-08-12**: Merged [#205](https://github.com/OpenCara/OpenCara/pull/205) - fix(azure-devops): stop INNER JOINs hiding Azure projects
- **2026-08-12**: Merged [#204](https://github.com/OpenCara/OpenCara/pull/204) - feat(azure-devops): support Personal Access Token connections
- **2026-08-12**: Merged [#203](https://github.com/OpenCara/OpenCara/pull/203) - feat(auth): link Azure DevOps to an existing account
- **2026-08-12**: Merged [#201](https://github.com/OpenCara/OpenCara/pull/201) - fix(web): only offer the Azure DevOps source when it is configured
- **2026-08-12**: Merged [#200](https://github.com/OpenCara/OpenCara/pull/200) - feat: Azure DevOps support (Entra sign-in, service hooks, PR flows)
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
- [x] Azure DevOps Personal Access Token connections, for organizations Entra cannot reach ([#204](https://github.com/OpenCara/OpenCara/pull/204))
- [x] fix: Azure DevOps projects hidden from the UI by INNER JOINs on github_installations ([#205](https://github.com/OpenCara/OpenCara/pull/205))
- [x] Link Azure DevOps to an existing GitHub account (settings page, `user_identities` linking) ([#203](https://github.com/OpenCara/OpenCara/pull/203))
- [x] fix(web): only offer the Azure DevOps source when it is configured ([#201](https://github.com/OpenCara/OpenCara/pull/201))
- [x] Azure DevOps support: platform-neutral `scm.*` flow node kinds + `ScmProvider` seam, Entra sign-in, organization connect, service hook subscriptions, and PR flows end-to-end ([#200](https://github.com/OpenCara/OpenCara/pull/200))

## In Progress

<!-- No items currently in progress -->

## Planned

### Azure DevOps follow-ups

Shipped in [#200](https://github.com/OpenCara/OpenCara/pull/200) with these gaps documented in README.md. **None of the Azure DevOps code has run against a live organization** — validating it there is the first item, since four review rounds found five defects and every one was in an unexercised path.

- [ ] Validate end-to-end against a real Azure DevOps organization (sign-in, connect, add repo, PR event → flow, worktree push, review thread + vote, vote cleared by a later comment-only review). The REST shapes most likely to need adjustment are the service hook subscription payload and the `connectionData` identity call.
- [ ] Boards / kanban parity: work item mirroring, `scm.board_item` trigger from `workitem.updated`. Work item events are received and recorded but drive nothing.
  - Blocker to resolve first: a work item event carries only the team project, so `resolveProject` in `webhooksAzure.ts` matches every OpenCara project under that team project and `.limit(1)` picks an arbitrary one. Harmless while these events drive nothing; board mirroring must key on the work item's linked repository or an explicit board↔project link.
- [ ] Inline PR diffs for Azure DevOps agents. There is no single unified-diff endpoint, so `stdin.diff` is empty and `OPENCARA_PR_DIFF_INLINE=0`; agents must `git diff` in the worktree. Reviewer flows *without* a worktree get no diff at all.
- [ ] Azure DevOps equivalents for the features currently skipped-with-a-log: auto-merge (`autoCompleteSetBy` + branch policies), PR↔work-item linking, draft-PR ready-for-review
- [ ] Device capability gating (`scm.azure_devops`). `pickIdle` ignores capabilities entirely — a pre-existing bug. Today a device on an older CLI fails an Azure DevOps worktree allocation with an "unknown argument" error, which is visible but not routed around.
- [ ] **`scm.pull_request_review` never fires on Azure DevOps**, so the review→fix half of `development-lifecycle` (and the standalone `pr-review-fix` flow) is dead there. Azure DevOps service hooks have no reviewer-vote event, and `git.pullrequest.updated` — which does fire on a vote — is indistinguishable from a push, so it maps to `synchronize`. Reviews post; nothing consumes them.
  - Possible lossy proxy: treat `git.pullrequest.updated` as a review event when a reviewer carries a non-zero vote. Needs dedup first, or it re-fires on every subsequent update to the same PR.
  - Only once the trigger fires does the next item matter: default its reviewer filter to the connection's user, since there is no `opencara[bot]` identity on Azure DevOps for the current default to match.
- [ ] Azure DevOps variants of the remaining `gh`-based skill prompts (`projectPm`, `projectDetail`, `flowRunStepChat`)
