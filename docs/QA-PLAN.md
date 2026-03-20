# QA Integration Test Plan

Cross-service integration test scenarios for the QA agent. Updated for the v1.0 stateless REST architecture.

**How to use**: QA agent runs these scenarios after code merges to verify cross-service integration beyond unit tests. Each scenario has setup, steps, and expected results.

---

## S01: Cross-Package Build Pipeline

**Tests**: Monorepo builds end-to-end with shared types consumed correctly.

**Steps**:

1. `pnpm install --frozen-lockfile` — install all dependencies
2. `pnpm build` — build all packages
3. `pnpm run typecheck` — verify TypeScript across all packages
4. `pnpm lint` — lint passes
5. `pnpm run format:check` — formatting is consistent

**Expected**: All commands exit 0. No warnings about missing types or broken references.

---

## S02: Shared Types Cross-Package Import

**Tests**: `packages/shared` exports are importable and usable by server and cli.

**Steps**:

1. Build shared: `cd packages/shared && pnpm build`
2. Build server: `cd packages/server && pnpm build` (imports from @opencara/shared)
3. Build cli: `cd packages/cli && pnpm build` (imports from @opencara/shared)
4. Verify key exports exist: `ReviewTask`, `TaskClaim`, `PollRequest`, `PollResponse`, `ClaimRequest`, `ClaimResponse`, `ResultRequest`, `ReviewConfig`

**Expected**: All builds succeed. No "module not found" or type errors on shared imports.

---

## S03: Webhook Signature Validation (Server)

**Tests**: `POST /webhook/github` validates HMAC-SHA256 signatures correctly.

**Steps**:

1. Run server integration tests: `cd packages/server && pnpm test`
2. Verify tests cover: valid signature → 200, invalid signature → 401, missing signature → 401

**Expected**: Signature validation correctly accepts/rejects requests.

---

## S04: Task Poll → Claim → Result Flow (Server)

**Tests**: Full REST task lifecycle works end-to-end.

**Steps**:

1. Run integration tests: `cd packages/server && pnpm test`
2. Verify tests cover:
   - Create task via webhook
   - Agent polls and sees task
   - Agent claims task
   - Agent submits result
   - Task transitions to completed

**Expected**: Task lifecycle works correctly. Status transitions are valid.

---

## S05: Multi-Agent Review Flow (Server)

**Tests**: Multiple agents can review a PR with synthesis.

**Steps**:

1. Run integration tests covering multi-agent scenarios
2. Verify:
   - Multiple agents can claim review slots
   - Summary slot opens after reviews complete
   - Summary agent receives completed review texts
   - Final review posted to GitHub

**Expected**: Multi-agent coordination works. Review texts are correctly passed to summary agent.

---

## S06: Timeout Handling (Server)

**Tests**: Timed-out tasks are handled correctly.

**Steps**:

1. Run timeout-specific integration tests
2. Verify:
   - Tasks past their timeout are detected during poll
   - Partial reviews are posted as individual comments
   - Timeout comment is posted to PR
   - Task status transitions to `timeout`

**Expected**: Timeout handling produces correct GitHub comments and status transitions.

---

## S07: CLI Smoke Test

**Tests**: CLI binary works and commands are registered.

**Steps**:

```bash
# Test CLI help
pnpm opencara --help
# Expect: shows available commands (agent)

# Test subcommands exist
pnpm opencara agent --help
# Expect: shows agent subcommands (start)
```

**Expected**: CLI responds correctly to help commands. No crashes.

---

## S08: Review Config Parsing (Shared)

**Tests**: `.review.yml` parser handles all scenarios.

**Steps**:

1. Run shared package tests: `cd packages/shared && pnpm test`
2. Verify tests cover:
   - Valid config with all fields
   - Config with only required fields (defaults applied)
   - Malformed YAML (graceful error)
   - Missing file (defaults used)

**Expected**: Parser returns valid config or uses defaults. No exceptions thrown.

---

## S09: GitHub App Integration (Server)

**Tests**: GitHub App JWT auth and installation token generation work.

**Steps**:

1. Run integration tests covering GitHub API mocking
2. Verify:
   - Installation token is generated from App ID + private key
   - Review is posted to GitHub PR
   - PR comment is posted on timeout

**Expected**: GitHub API integration produces correct API calls.

---

## S10: Eligibility Filtering (Server)

**Tests**: PR skip rules work correctly.

**Steps**:

1. Run eligibility tests
2. Verify:
   - Draft PRs are skipped when `skip_drafts: true`
   - PRs with skip labels are skipped
   - PRs targeting skip branches are skipped
   - Only configured trigger actions create tasks

**Expected**: Eligibility filtering correctly skips/accepts PRs based on config.
