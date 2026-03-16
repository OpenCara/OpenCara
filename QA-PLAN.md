# QA Integration Test Plan

Cross-service integration test scenarios for the QA agent. Updated after each milestone merge.

**How to use**: QA agent runs these scenarios after code merges to verify cross-service integration beyond unit tests. Each scenario has setup, steps, and expected results.

---

## Milestone Coverage

| Milestone | Status | Scenarios |
|-----------|--------|-----------|
| M0 | DONE | S01-S02 |
| M1 | DONE | S03-S06 |
| M2 | DONE | S07-S10 |
| M3 | DONE | S11-S13 |
| M4 | IN PROGRESS | — |

---

## S01: Cross-Package Build Pipeline

**Tests**: Monorepo builds end-to-end with shared types consumed correctly.

**Steps**:
1. `npm ci` — install all dependencies
2. `npm run build` — build all packages
3. `npm run typecheck` — verify TypeScript across all packages
4. `npm run lint` — lint passes
5. `npm run format:check` — formatting is consistent

**Expected**: All commands exit 0. No warnings about missing types or broken references.

---

## S02: Shared Types Cross-Package Import

**Tests**: `packages/shared` exports are importable and usable by worker, cli, and web.

**Steps**:
1. Build shared: `cd packages/shared && npm run build`
2. Build worker: `cd packages/worker && npm run build` (imports from @opencrust/shared)
3. Build cli: `cd packages/cli && npm run build` (imports from @opencrust/shared)
4. Verify key exports exist: `ReviewConfig`, `API_KEY_PREFIX`, `PlatformMessage`, `AgentMessage`, `DeviceFlowResponse`

**Expected**: All builds succeed. No "module not found" or type errors on shared imports.

---

## S03: Webhook Signature Validation (Worker)

**Tests**: `POST /webhook/github` validates HMAC-SHA256 signatures correctly.

**Steps**:
1. Start Worker locally: `cd packages/worker && npx wrangler dev --port $PORT`
2. Send POST with valid signature → expect 200
3. Send POST with invalid signature → expect 401
4. Send POST with missing `X-Hub-Signature-256` header → expect 401
5. Send POST with empty body + valid signature for empty body → expect 200

**Expected**: Signature validation correctly accepts/rejects requests. No crashes on malformed input.

---

## S04: Webhook PR Event Routing (Worker)

**Tests**: Worker correctly routes `pull_request` events and ignores unknown events.

**Steps**:
1. Start Worker locally
2. Send `pull_request.opened` event with valid signature → expect 200, handler invoked
3. Send `pull_request.synchronize` event → expect 200, handler invoked
4. Send `pull_request.closed` event → expect 200, no handler (graceful skip)
5. Send `issues.opened` event → expect 200, no handler (graceful skip)
6. Send malformed JSON body with valid signature → expect non-crash (400 or 200)

**Expected**: Only `pull_request.opened` and `pull_request.synchronize` trigger the PR handler. All other events return 200 without error.

---

## S05: Review Config Parsing (Shared + Worker)

**Tests**: `.review.yml` parser handles all validation scenarios.

**Steps**:
1. Parse valid config with all fields → expect `ReviewConfig` with correct values
2. Parse config with only required fields (`version`, `prompt`) → expect defaults applied:
   - `agents.minCount: 1`, `agents.minReputation: 0.0`, `timeout: "10m"`
3. Parse config with missing `version` → expect error
4. Parse config with missing `prompt` → expect error
5. Parse malformed YAML (invalid syntax) → expect error
6. Parse empty string → expect error

**Expected**: Parser returns valid config or descriptive error. No exceptions thrown.

---

## S06: Installation Event Handling (Worker)

**Tests**: GitHub App installation create/delete events are handled.

**Steps**:
1. Start Worker locally
2. Send `installation.created` event with valid signature → expect 200
3. Send `installation.deleted` event with valid signature → expect 200

**Expected**: Events are accepted. DB operations are stubbed/logged (full DB integration in M2+).

---

## S07: Auth Device Flow End-to-End (Worker)

**Tests**: OAuth device flow endpoints work together.

**Steps**:
1. Start Worker locally with mock GitHub OAuth (or test against real GitHub staging)
2. `POST /auth/device` → expect response with `userCode`, `verificationUri`, `deviceCode`, `interval`, `expiresIn`
3. `POST /auth/device/token` with `{ deviceCode }` before authorization → expect `{ status: "pending" }`
4. After authorization: `POST /auth/device/token` → expect `{ status: "complete", apiKey: "cr_..." }`
5. Verify API key format: starts with `cr_`, 43 chars total (3 prefix + 40 hex)

**Expected**: Full device flow produces a valid API key. Pending state correctly reported.

---

## S08: API Key Auth Middleware (Worker)

**Tests**: Authenticated endpoints reject invalid keys and accept valid ones.

**Steps**:
1. Start Worker locally
2. `GET /api/agents` without Authorization header → expect 401
3. `GET /api/agents` with `Authorization: Bearer invalid_key` → expect 401
4. `GET /api/agents` with valid API key → expect 200 with agents array
5. `POST /api/agents` without auth → expect 401

**Expected**: Auth middleware consistently blocks unauthenticated requests across all protected endpoints.

---

## S09: Agent CRUD (Worker)

**Tests**: Agent create and list endpoints work correctly with auth.

**Steps**:
1. Authenticate (obtain valid API key)
2. `POST /api/agents` with `{ "model": "claude-sonnet-4-6", "tool": "claude-code" }` → expect 200 with agent object
3. `GET /api/agents` → expect array containing the created agent
4. `POST /api/agents` with missing `model` → expect 400
5. `POST /api/agents` with missing `tool` → expect 400
6. Create second agent → `GET /api/agents` returns both

**Expected**: CRUD operations work correctly. Validation rejects incomplete requests.

---

## S10: API Key Revocation (Worker)

**Tests**: Revoking an API key invalidates the old one and returns a new one.

**Steps**:
1. Authenticate with valid API key A
2. `POST /auth/revoke` with key A → expect 200 with new `apiKey` B
3. `GET /api/agents` with old key A → expect 401
4. `GET /api/agents` with new key B → expect 200

**Expected**: Old key immediately invalid. New key works for all endpoints.

---

## S11: CLI Login Flow (CLI → Worker)

**Tests**: `opencrust login` calls the correct Worker endpoints and saves config.

**Steps**:
1. Start Worker locally
2. Run `opencrust login` (with mocked user interaction or `--platform-url` flag)
3. Verify it calls `POST /auth/device`
4. Verify it polls `POST /auth/device/token`
5. On success, verify `~/.opencrust/config.yml` contains `api_key: cr_...`
6. Verify config file permissions are 0o600

**Expected**: Login flow produces valid config file with correct API key.

---

## S12: CLI Agent Commands (CLI → Worker)

**Tests**: `opencrust agent create/list` calls correct Worker endpoints.

**Steps**:
1. Ensure valid config exists (from S11 or manual setup)
2. `opencrust agent create --model claude-sonnet-4-6 --tool claude-code` → expect success output with agent ID
3. `opencrust agent list` → expect table output with created agent
4. Run commands without config (no API key) → expect clear error message

**Expected**: CLI correctly calls REST API and displays results. Error messages are actionable.

---

## S13: CLI WebSocket Connection (CLI → Worker)

**Tests**: `opencrust agent start` establishes WebSocket and handles messages.

**Steps**:
1. Ensure valid config and registered agent exist
2. `opencrust agent start <agentId>` → verify WebSocket connection attempt
3. On connection: verify `connected` message is received
4. Verify heartbeat_ping → heartbeat_pong exchange
5. Send SIGINT → verify graceful disconnect
6. Verify reconnect behavior on connection drop (exponential backoff)

**Expected**: WebSocket connects, authenticates, handles heartbeat, and reconnects on failure. Note: full WebSocket server (Durable Objects) is M4 — this scenario tests against a mock or local WS server.

---

## Future Scenarios (pending milestones)

### M4: Durable Objects
- S14: Agent connects via WebSocket, DO manages connection state
- S15: Heartbeat timeout disconnects unresponsive agents
- S16: Duplicate connection replaces old one (close code 4002)
- S17: PR webhook triggers task creation and agent distribution
- S18: Task timeout alarm fires and transitions task status

### M5: Single Agent Review Loop
- S19: Full loop: PR webhook → task → agent receives → reviews → result posted to GitHub
- S20: Agent rejection/error triggers redistribution

### M6-M9: Later milestones
- Scenarios added when milestones are designed
