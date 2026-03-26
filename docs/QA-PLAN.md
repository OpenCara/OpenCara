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

**Tests**: `.review.toml` parser handles all scenarios.

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

---

## S11: OAuth Device Flow Proxy Endpoints (Server)

**Added after**: M17 OAuth Authentication (PRs #454, #457)

**Tests**: Server-side OAuth proxy endpoints correctly forward Device Flow requests to GitHub without exposing the client secret.

**Steps**:

1. Run `cd packages/server && pnpm test -- routes-auth`
2. Verify tests cover:
   - `POST /api/auth/device` — initiates device flow, returns `device_code` + `user_code`
   - `POST /api/auth/device/token` — polls for token, handles `authorization_pending`, `slow_down`, `expired_token`, `access_denied`
   - `POST /api/auth/refresh` — refreshes expired access token using refresh token
   - Client secret is never exposed in any response
   - Rate limiting applied: 5 req/min on device init, 10 req/min on token poll and refresh
   - Validation rejects missing/empty `device_code` and `refresh_token`
   - Returns 500 when `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` not configured

**Expected**: All proxy endpoints work correctly. Client secret never leaks. Rate limits enforced.

---

## S12: OAuth Token Verification Middleware (Server)

**Added after**: M17 OAuth Authentication (PRs #456, #459)

**Tests**: Server verifies OAuth tokens via GitHub API, caches results in D1, and sets verified identity on the request context.

**Steps**:

1. Run `cd packages/server && pnpm test -- oauth-middleware`
2. Verify tests cover:
   - Token hashing: SHA-256, consistent output, 64-char hex string
   - Token verification via GitHub API `POST /applications/{client_id}/token`
   - Valid token → `VerifiedIdentity` set in context
   - Revoked token (404) → `AUTH_TOKEN_REVOKED` (401)
   - Expired token (422) → `AUTH_TOKEN_EXPIRED` (401)
   - Missing Authorization header → `AUTH_REQUIRED` (401)
   - Cache hit on second request (GitHub API not called again)
   - Cache expiry: expired entries return null
   - Backward compatibility: API key auth works when `OAUTH_REQUIRED` is not set
   - Open mode: no auth required when neither `API_KEYS` nor `OAUTH_REQUIRED` is set
   - OAuth enforced on all mutation endpoints (claim, result, reject, error)

**Expected**: Token verification works correctly. Cache avoids redundant GitHub API calls. Backward compat preserved.

---

## S13: Verified Identity in Task Routes (Server)

**Added after**: M17 OAuth Authentication (PR #459)

**Tests**: Task routes derive agent identity from the verified OAuth token instead of self-reported `github_username` in request bodies.

**Steps**:

1. Run `cd packages/server && pnpm test -- oauth-middleware` (verified identity tests are in this file)
2. Verify tests cover:
   - Poll uses verified `github_username` for eligibility (whitelist/blacklist match)
   - Poll filters out tasks when verified username not in whitelist
   - Claim stores `github_user_id` from verified identity
   - Claim uses verified username for eligibility checks
   - Claim rejects when verified username not eligible
   - No `github_user_id` stored when OAuth is not enforced (backward compat)
   - `agent_id` still accepted from request body for session correlation

**Expected**: Identity comes from verified OAuth token, not request body. Eligibility checks use verified username.

---

## S14: CLI OAuth Auth Module (CLI)

**Added after**: M17 OAuth Authentication (PR #455)

**Tests**: CLI auth module handles Device Flow login, token storage, automatic refresh, and user resolution.

**Steps**:

1. Run `cd packages/cli && pnpm test -- auth.test`
2. Verify tests cover:
   - **Token storage**: `~/.opencara/auth.json` — load, save (atomic write), delete
   - **File permissions**: `0o600` (owner read/write only)
   - **Auth file path**: default path + `OPENCARA_AUTH_FILE` env override
   - **Login (Device Flow)**: full flow, `authorization_pending` polling, `slow_down` interval increase, `expired_token` error, `access_denied` error, timeout
   - **Token refresh** (`getValidToken`): returns token when valid, refreshes within 5-min buffer, refreshes when expired, throws when refresh fails
   - **User resolution** (`resolveUser`): returns `login` + `id` from GitHub API, handles errors
   - **Validation**: rejects auth files with missing/wrong-typed fields

**Expected**: Auth module handles all Device Flow states. Token storage is secure (0o600). Refresh is transparent.

---

## S15: CLI Auth Commands (CLI)

**Added after**: M17 OAuth Authentication (PR #458)

**Tests**: `opencara auth login/status/logout` subcommands work correctly.

**Steps**:

1. Run `cd packages/cli && pnpm test -- auth-commands`
2. Verify tests cover:
   - `opencara auth login` — completes Device Flow, stores token
   - `opencara auth login` when already logged in — prompts for re-authentication
   - `opencara auth status` — shows authenticated state with expiry time
   - `opencara auth status` when not logged in — shows "Not authenticated"
   - `opencara auth status` with expired token — shows warning
   - `opencara auth logout` — deletes auth file, shows confirmation
   - `opencara auth logout` when not logged in — shows "Not logged in"
   - Command group structure: `auth` with `login`, `status`, `logout` subcommands
3. Verify CLI help: `pnpm opencara auth --help` — shows all three subcommands

**Expected**: All auth commands produce correct output and handle edge cases.

---

## S16: CLI OAuth Integration — Single Token (CLI)

**Added after**: M17 OAuth Authentication (PR #460)

**Tests**: Agent uses a single OAuth token for both server API auth and GitHub API diff/PR-context fetching. Old `github-auth.ts` fallback chain is completely removed.

**Steps**:

1. Run full CLI test suite: `cd packages/cli && pnpm test`
2. Verify:
   - `github-auth.ts` no longer exists (deleted)
   - `ApiClient` uses `authToken` (not `apiKey`) for `Authorization: Bearer` header
   - `ApiClient` handles `AUTH_TOKEN_EXPIRED` response by refreshing and retrying once
   - `githubToken` and `githubUsername` removed from `CliConfig`
   - `github_token` field in `LocalAgentConfig` removed
   - Deprecation warnings logged for old config fields (`github_token`, `github_username`)
   - `github_username` not sent in `PollRequest` or `ClaimRequest` payloads
3. Verify no `gh` CLI dependency: `grep -r "gh auth" packages/cli/src/ || echo "PASS: no gh CLI references"`

**Expected**: Single OAuth token used everywhere. No `gh` CLI dependency. Deprecated config fields produce warnings.

---

## S17: OAuth Error Handling (Server + CLI)

**Added after**: M17 OAuth Authentication (PRs #454-#460)

**Tests**: Error cases are handled correctly across server and CLI.

**Steps**:

1. Run `cd packages/server && pnpm test -- oauth-middleware routes-auth`
2. Run `cd packages/cli && pnpm test -- auth.test auth-commands`
3. Verify error cases covered:
   - **Server**: Missing auth header → `AUTH_REQUIRED`, revoked token → `AUTH_TOKEN_REVOKED`, expired token → `AUTH_TOKEN_EXPIRED`
   - **Server**: GitHub API unreachable during verification → 500 `INTERNAL_ERROR`
   - **Server**: Missing `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` env vars → 500
   - **CLI**: Login timeout → error message
   - **CLI**: User denies authorization → error message
   - **CLI**: Token refresh failure → prompts re-login
   - **CLI**: `getValidToken` when not authenticated → throws AuthError

**Expected**: All error paths produce clear error messages/codes. No unhandled exceptions.

---

## S18: OAuth Shared Types (Shared)

**Added after**: M17 OAuth Authentication (PR #454)

**Tests**: Shared package exports new OAuth types and `github_username` removed from API request types.

**Steps**:

1. Run `cd packages/shared && pnpm test`
2. Verify:
   - `VerifiedIdentity` type exported from `@opencara/shared`
   - `DeviceFlowInitResponse`, `DeviceFlowTokenRequest`, `DeviceFlowTokenResponse` exported
   - `RefreshTokenRequest`, `RefreshTokenResponse` exported
   - `AUTH_REQUIRED`, `AUTH_TOKEN_EXPIRED`, `AUTH_TOKEN_REVOKED` in `ErrorCode` union
   - `github_username` field absent from `PollRequest` and `ClaimRequest` types
   - `allow_anonymous` in `.review.toml` produces deprecation warning, not parse error
3. Verify type-safety across packages: `pnpm run typecheck`

**Expected**: All new types exported. Removed fields cause no compile errors. Deprecation handled gracefully.
