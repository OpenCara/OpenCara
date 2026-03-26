# QA Testing Plan — M19 Unified Multi-Agent Pipeline

## Overview

Four testing tiers, progressing from isolated mocks to full production integration.
Each tier builds confidence that the previous tier's contracts hold in a more realistic environment.

**Scope**: M19 changes (#501-#509) — unified FeatureConfig, TaskRole types, separate task model,
webhook refactor (createTaskGroup, issue events), poll/claim/result refactor, CLI dedup/triage handlers.

---

## Tier 1: CLI with Fake Server API

**Goal**: Verify CLI agent behavior against a controlled server with predictable responses.

**Infrastructure**: Vitest + FakeServer (in-process Hono app with MemoryDataStore + mocked tool executor).
Uses existing `packages/cli/src/__tests__/helpers/fake-server.ts`.

### Test Scenarios

#### 1.1 Review Pipeline (existing, verify still passes)

- [ ] Single-agent review: inject task (agentCount=1) → agent polls → claims as `summary` → executes tool → submits result → task completes
- [ ] Multi-agent review: inject task (agentCount=3) → 2 agents claim as `review` → submit results → 1 agent claims `summary` → synthesizes → submits → task completes
- [ ] Review-only agent skips summary tasks
- [ ] Synthesizer-only agent skips review tasks
- [ ] `roles` field in agent config correctly filters task types (review, dedup, triage, summary)

#### 1.2 Dedup Pipeline (new)

- [ ] PR dedup task: inject dedup task → agent polls → claims as `dedup` → `executeDedupTask()` builds prompt with PR list → mock tool returns structured `DedupReport` → agent submits result
- [ ] Issue dedup task: same flow but with issue context instead of PR context
- [ ] Dedup prompt builder includes anti-injection boundaries around untrusted PR/issue content
- [ ] Multi-agent dedup (agentCount > 1): worker tasks → summary task aggregation
- [ ] Agent with `roles: ["review"]` does NOT see dedup tasks in poll
- [ ] Agent with `roles: ["dedup"]` sees only dedup tasks

#### 1.3 Triage Pipeline (new)

- [ ] Triage task: inject triage task → agent polls → claims as `triage` → `executeTriageTask()` builds prompt with issue body → mock tool returns `TriageReport` → agent submits result
- [ ] Triage prompt builder wraps issue body/title in `<UNTRUSTED_CONTENT>` boundaries
- [ ] Multi-agent triage: worker tasks → summary task aggregation
- [ ] Agent with `roles: ["review", "dedup"]` does NOT see triage tasks
- [ ] Agent with `roles: ["triage"]` sees only triage tasks

#### 1.4 Role Filtering

- [ ] Agent with no `roles` field (default): sees review + summary tasks (backward compat)
- [ ] Agent with `roles: ["review", "dedup", "triage", "summary"]`: sees all task types
- [ ] Agent with `roles: ["dedup"]`: sees only dedup tasks
- [ ] Poll response `task_type` field correctly identifies review/dedup/triage tasks

#### 1.5 Error Paths

- [ ] Tool execution failure during dedup → agent reports error → task gets error status
- [ ] Tool execution failure during triage → same
- [ ] Diff too large → agent rejects dedup/triage task gracefully
- [ ] Invalid/malformed DedupReport from tool → agent handles gracefully (submits raw text)

### How to Run

```bash
cd packages/cli
pnpm vitest run src/__tests__/e2e-agent.test.ts
pnpm vitest run src/__tests__/cli-server-integration.test.ts
pnpm vitest run src/__tests__/dedup.test.ts
pnpm vitest run src/__tests__/triage.test.ts
pnpm vitest run src/__tests__/config.test.ts  # roles field parsing
```

---

## Tier 2: Server with curl and Fake GitHub Webhook

**Goal**: Verify server API routes and webhook handling in isolation, using the Node.js entry point
with `DEV_MODE=true` (test routes mounted, NoOpGitHubService for posting).

**Infrastructure**: Node.js server (`packages/server/src/node.ts`) with SQLite (D1DataStore via better-sqlite3).
Test routes at `/test/*` bypass webhook signature verification.

### Setup

```bash
# Terminal 1: Start server in dev mode
cd packages/server
pnpm build
DEV_MODE=true PORT=3456 DATABASE_PATH=/tmp/opencara-qa.db node dist/node.js
```

### Test Scenarios

#### 2.1 Task Group Creation

```bash
# Create a review task group (agentCount=3)
curl -s -X POST http://localhost:3456/test/events/pr \
  -H 'Content-Type: application/json' \
  -d '{"owner":"test","repo":"qa-repo","pr_number":1,"config":{"agentCount":3}}' | jq .
# Expected: { "created": true, "task_id": "...", "group_id": "..." }

# Verify tasks created in the group
curl -s http://localhost:3456/test/tasks | jq '.tasks | length'
# Expected: 3 (for agentCount=3: 2 review workers + 1 pending summary)
# Or: the new model may create agentCount worker tasks + 1 summary = 4

# Verify task_type fields
curl -s http://localhost:3456/test/tasks | jq '[.tasks[] | {id: .id, task_type, status, group_id}]'

# Create a single-agent task
curl -s -X POST http://localhost:3456/test/events/pr \
  -H 'Content-Type: application/json' \
  -d '{"owner":"test","repo":"qa-repo","pr_number":2,"config":{"agentCount":1}}' | jq .
# Expected: 1 task with task_type=summary
```

#### 2.2 Poll/Claim/Result Cycle

```bash
# Poll for tasks
curl -s -X POST http://localhost:3456/api/tasks/poll \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"qa-agent-1"}' | jq .
# Expected: tasks array with task_type field (review/summary/dedup/triage)

# Claim a task
TASK_ID="<from poll response>"
curl -s -X POST "http://localhost:3456/api/tasks/$TASK_ID/claim" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"qa-agent-1","role":"review","model":"test-model","tool":"test-tool"}' | jq .
# Expected: { "claimed": true, ... }

# Submit result
curl -s -X POST "http://localhost:3456/api/tasks/$TASK_ID/result" \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id":"qa-agent-1",
    "type":"review",
    "review_text":"## Summary\nLooks good.\n\n## Findings\nNone.\n\n## Verdict\nAPPROVE",
    "verdict":"approve",
    "tokens_used":100
  }' | jq .
# Expected: { "accepted": true }
```

#### 2.3 Multi-Agent Review Flow (Full Cycle)

```bash
# 1. Reset state
curl -s -X POST http://localhost:3456/test/reset | jq .

# 2. Create task group (agentCount=3)
RESULT=$(curl -s -X POST http://localhost:3456/test/events/pr \
  -H 'Content-Type: application/json' \
  -d '{"owner":"test","repo":"qa","pr_number":10,"config":{"agentCount":3}}')
GROUP_ID=$(echo "$RESULT" | jq -r '.group_id')
echo "Group: $GROUP_ID"

# 3. Agent A polls and claims review
POLL_A=$(curl -s -X POST http://localhost:3456/api/tasks/poll \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent-A"}')
TASK_A=$(echo "$POLL_A" | jq -r '.tasks[0].task_id')
curl -s -X POST "http://localhost:3456/api/tasks/$TASK_A/claim" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent-A","role":"review"}' | jq .

# 4. Agent A submits review
curl -s -X POST "http://localhost:3456/api/tasks/$TASK_A/result" \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id":"agent-A","type":"review",
    "review_text":"## Summary\nReview A. Minor style issue found.\n\n## Findings\n- Line 5: unused import\n\n## Verdict\nAPPROVE",
    "verdict":"approve","tokens_used":200
  }' | jq .

# 5. Agent B polls, claims, submits second review
POLL_B=$(curl -s -X POST http://localhost:3456/api/tasks/poll \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent-B"}')
TASK_B=$(echo "$POLL_B" | jq -r '.tasks[0].task_id')
curl -s -X POST "http://localhost:3456/api/tasks/$TASK_B/claim" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent-B","role":"review"}' | jq .
curl -s -X POST "http://localhost:3456/api/tasks/$TASK_B/result" \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id":"agent-B","type":"review",
    "review_text":"## Summary\nReview B. Code looks clean.\n\n## Findings\nNo issues.\n\n## Verdict\nAPPROVE",
    "verdict":"approve","tokens_used":150
  }' | jq .

# 6. Agent C polls — should see summary task with worker results attached
POLL_C=$(curl -s -X POST http://localhost:3456/api/tasks/poll \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent-C"}')
echo "$POLL_C" | jq '.tasks[0] | {task_id, role, worker_results}'
# Expected: summary task with worker_results containing reviews from A and B

# 7. Agent C claims summary and submits synthesis
TASK_C=$(echo "$POLL_C" | jq -r '.tasks[0].task_id')
curl -s -X POST "http://localhost:3456/api/tasks/$TASK_C/claim" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent-C","role":"summary"}' | jq .
curl -s -X POST "http://localhost:3456/api/tasks/$TASK_C/result" \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id":"agent-C","type":"summary",
    "review_text":"## Consolidated Review\n\nTwo reviewers examined this PR. One minor unused import flagged.\n\nOverall: clean code with a trivial cleanup opportunity.\n\n## Verdict\nAPPROVE",
    "verdict":"approve","tokens_used":300
  }' | jq .

# 8. Verify all tasks complete
curl -s http://localhost:3456/test/tasks | jq '[.tasks[] | {id: .id[:8], status, task_type}]'
# Expected: all tasks in "completed" or "posted" status
```

#### 2.4 Idempotency and Edge Cases

```bash
# Duplicate webhook — same PR, same repo
curl -s -X POST http://localhost:3456/test/events/pr \
  -H 'Content-Type: application/json' \
  -d '{"owner":"test","repo":"qa","pr_number":10}' | jq .
# Expected: { "created": false, "reason": "Active task already exists..." }

# Claim conflict — two agents race for same task
curl -s -X POST http://localhost:3456/test/reset | jq .
RESULT=$(curl -s -X POST http://localhost:3456/test/events/pr \
  -H 'Content-Type: application/json' \
  -d '{"owner":"test","repo":"edge","pr_number":1,"config":{"agentCount":1}}')
TASK=$(echo "$RESULT" | jq -r '.task_id')
# First claim succeeds
curl -s -X POST "http://localhost:3456/api/tasks/$TASK/claim" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"fast-agent","role":"summary"}' | jq .
# Second claim fails
curl -s -X POST "http://localhost:3456/api/tasks/$TASK/claim" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"slow-agent","role":"summary"}' | jq .
# Expected: { "error": { "code": "CLAIM_CONFLICT", ... } }
```

### Cleanup

```bash
curl -s -X POST http://localhost:3456/test/reset | jq .
# Stop server: Ctrl+C
rm /tmp/opencara-qa.db
```

---

## Tier 3: Server + CLI with Fake GitHub Webhook (Local Integration)

**Goal**: Run the real CLI agent loop against the real Node.js server, with a simple tool
command that returns canned reviews. Verifies the full poll-claim-execute-submit cycle
over real HTTP — no Vitest mocking, no fetch interception.

**Infrastructure**:

- Server: Node.js entry point (`DEV_MODE=true`) with SQLite
- CLI: real `opencara agent start` with a shell echo command as the tool
- No GitHub App needed (NoOpGitHubService in DEV_MODE)

### Setup

```bash
# Build everything
pnpm build

# Terminal 1: Start server
DEV_MODE=true PORT=3456 DATABASE_PATH=/tmp/opencara-tier3.db \
  node packages/server/dist/node.js
```

### 3.1 Single-Agent Review

```bash
# Terminal 2: Create config and start agent
mkdir -p /tmp/oc-qa
cat > /tmp/oc-qa/config.toml << 'TOML'
platform_url = "http://localhost:3456"

[[agents]]
model = "qa-model"
tool = "claude"
name = "QA Agent"
command = "echo '## Summary\nNo issues found.\n\n## Findings\nNone.\n\n## Verdict\nAPPROVE'"
TOML

OPENCARA_CONFIG=/tmp/oc-qa/config.toml node packages/cli/dist/index.js agent start

# Terminal 3: Inject a task
curl -s -X POST http://localhost:3456/test/events/pr \
  -H 'Content-Type: application/json' \
  -d '{"owner":"test","repo":"tier3","pr_number":1,"config":{"agentCount":1}}'

# Watch Terminal 2 for:
#   ✓ Polling for tasks...
#   ✓ Claimed task ... as summary
#   ✓ Executing: echo '...'
#   ✓ Result submitted

# Verify
curl -s http://localhost:3456/test/tasks | jq '[.tasks[] | {id: .id[:8], status}]'
# Expected: status = "completed" or "posted"
```

### 3.2 Multi-Agent Review (3 Agents in Parallel)

```bash
# Create 3 agent configs
cat > /tmp/oc-qa/review-a.toml << 'TOML'
platform_url = "http://localhost:3456"
[[agents]]
model = "model-A"
tool = "claude"
command = "echo '## Summary\nAgent A review.\n\n## Findings\nMinor style issue.\n\n## Verdict\nAPPROVE'"
roles = ["review"]
TOML

cat > /tmp/oc-qa/review-b.toml << 'TOML'
platform_url = "http://localhost:3456"
[[agents]]
model = "model-B"
tool = "claude"
command = "echo '## Summary\nAgent B review.\n\n## Findings\nLooks clean.\n\n## Verdict\nAPPROVE'"
roles = ["review"]
TOML

cat > /tmp/oc-qa/summary.toml << 'TOML'
platform_url = "http://localhost:3456"
[[agents]]
model = "model-C"
tool = "claude"
command = "echo '## Consolidated Review\n\nBoth reviewers approve.\n\n## Verdict\nAPPROVE'"
roles = ["summary"]
TOML

# Start 3 agents in background
OPENCARA_CONFIG=/tmp/oc-qa/review-a.toml node packages/cli/dist/index.js agent start &
OPENCARA_CONFIG=/tmp/oc-qa/review-b.toml node packages/cli/dist/index.js agent start &
OPENCARA_CONFIG=/tmp/oc-qa/summary.toml node packages/cli/dist/index.js agent start &

# Inject 3-agent task
curl -s -X POST http://localhost:3456/test/events/pr \
  -H 'Content-Type: application/json' \
  -d '{"owner":"test","repo":"tier3","pr_number":2,"config":{"agentCount":3}}'

# Wait ~30 seconds for all agents to complete, then verify
sleep 30
curl -s http://localhost:3456/test/tasks | jq '[.tasks[] | select(.pr_number == 2) | {id: .id[:8], status, task_type}]'
# Expected: all tasks completed

# Stop background agents
kill %1 %2 %3 2>/dev/null
```

### 3.3 Role Isolation Verification

```bash
# Reset
curl -s -X POST http://localhost:3456/test/reset | jq .

# Start dedup-only agent
cat > /tmp/oc-qa/dedup.toml << 'TOML'
platform_url = "http://localhost:3456"
[[agents]]
model = "dedup-model"
tool = "claude"
command = "echo 'no duplicates found'"
roles = ["dedup"]
TOML

OPENCARA_CONFIG=/tmp/oc-qa/dedup.toml node packages/cli/dist/index.js agent start &

# Inject a REVIEW task — dedup agent should NOT claim it
curl -s -X POST http://localhost:3456/test/events/pr \
  -H 'Content-Type: application/json' \
  -d '{"owner":"test","repo":"tier3","pr_number":3,"config":{"agentCount":1}}'

# Wait and verify task is still pending (not claimed by dedup agent)
sleep 20
curl -s http://localhost:3456/test/tasks | jq '[.tasks[] | select(.pr_number == 3) | {status}]'
# Expected: status = "pending" (dedup agent ignores review tasks)

kill %1 2>/dev/null
```

### Cleanup

```bash
kill %1 %2 %3 2>/dev/null
rm -rf /tmp/opencara-tier3.db /tmp/oc-qa
```

---

## Tier 4: Full E2E — Server + CLI + Dev Test Repo

**Goal**: Verify the complete system against the deployed dev worker and a real GitHub repo.
Tests webhook delivery, GitHub App permissions, diff fetching, review posting, and the full
agent lifecycle with real AI tools.

**Infrastructure**:

- Server: `opencara-server-dev` on Cloudflare Workers (auto-deployed from main)
- CLI: `npx opencara agent start --all` with real `~/.opencara/config.toml`
- GitHub: `OpenCara/opencara-dev-test` test repo
- AI tools: real configured tools (claude, qwen, etc.)

### Prerequisites

1. Dev worker deployed with latest main (check: `curl -s https://opencara-server-dev.opencara.workers.dev/ | jq .`)
2. GitHub App installed on `OpenCara/opencara-dev-test`
3. `~/.opencara/config.toml` configured with at least one agent
4. `gh` CLI authenticated (`gh auth status`)
5. OAuth login complete (`opencara auth login`)

### 4.1 Smoke Test — Single-Agent Review

```bash
# Create a test PR
PR_NUM=$(scripts/create-test-pr.sh --repo OpenCara/opencara-dev-test)
echo "Test PR: #$PR_NUM"

# Start agents
OPENCARA_PLATFORM_URL=https://opencara-server-dev.opencara.workers.dev \
  npx opencara agent start --all

# Wait for bot review (up to 5 minutes)
scripts/wait-bot-review.sh $PR_NUM

# Verify review posted
gh api repos/OpenCara/opencara-dev-test/issues/$PR_NUM/comments \
  --jq '[.[] | select(.user.login | contains("opencara")) | {user: .user.login, body: .body[:100]}]'

# Cleanup
gh pr close $PR_NUM --repo OpenCara/opencara-dev-test --delete-branch
```

### 4.2 Multi-Agent Review (agentCount=3)

```bash
# Verify .opencara.toml has agent_count = 3
gh api repos/OpenCara/opencara-dev-test/contents/.opencara.toml \
  --jq '.content' | base64 -d | grep agent_count

# Create test PR
PR_NUM=$(scripts/create-test-pr.sh --repo OpenCara/opencara-dev-test)

# Start multiple agents
OPENCARA_PLATFORM_URL=https://opencara-server-dev.opencara.workers.dev \
  npx opencara agent start --all

# Wait for consolidated review
scripts/wait-bot-review.sh $PR_NUM

# Verify: bot comment should reference multiple reviewers
gh api repos/OpenCara/opencara-dev-test/issues/$PR_NUM/comments \
  --jq '.[] | select(.user.login | contains("opencara")) | .body' | head -30

# Cleanup
gh pr close $PR_NUM --repo OpenCara/opencara-dev-test --delete-branch
```

### 4.3 Bug #519 Verification — agent_count Takes Effect

This is the critical test. After #505 (webhook refactor) and #506 (poll/claim/result refactor)
deploy, `agent_count = 3` must produce 3 separate review agents, not a single summary agent.

```bash
# 1. Confirm config
gh api repos/OpenCara/opencara-dev-test/contents/.opencara.toml \
  --jq '.content' | base64 -d

# 2. Create test PR
PR_NUM=$(scripts/create-test-pr.sh --repo OpenCara/opencara-dev-test)

# 3. Start agents — watch logs carefully
OPENCARA_PLATFORM_URL=https://opencara-server-dev.opencara.workers.dev \
  npx opencara agent start --all 2>&1 | tee /tmp/agent-519-test.log

# 4. Check agent logs for:
#    PASS: Multiple agents claiming "review" role before one claims "summary"
#    FAIL: Single agent claiming "summary" directly (bug still present)
grep -E "(Claimed|claim)" /tmp/agent-519-test.log

# 5. Verify bot review mentions multiple reviewers
scripts/wait-bot-review.sh $PR_NUM
gh api repos/OpenCara/opencara-dev-test/issues/$PR_NUM/comments \
  --jq '.[] | select(.user.login | contains("opencara")) | .body' | grep -i "review"

# Cleanup
gh pr close $PR_NUM --repo OpenCara/opencara-dev-test --delete-branch
```

### 4.4 Issue Triage (if enabled in .opencara.toml)

```bash
# Verify triage is enabled
gh api repos/OpenCara/opencara-dev-test/contents/.opencara.toml \
  --jq '.content' | base64 -d | grep -A5 '\[triage\]'

# Create test issue
ISSUE_NUM=$(gh issue create --repo OpenCara/opencara-dev-test \
  --title "QA: Feature request for improved logging" \
  --body "We need detailed debug logging in the agent loop." \
  | grep -oP '\d+$')
echo "Test issue: #$ISSUE_NUM"

# Start agents (if not already running)
# Watch for triage task claim in logs

# Verify: bot posts triage comment or applies labels
sleep 120
gh api repos/OpenCara/opencara-dev-test/issues/$ISSUE_NUM/comments --jq '.[].body'

# Cleanup
gh issue close $ISSUE_NUM --repo OpenCara/opencara-dev-test
```

### 4.5 Negative Tests

```bash
# Draft PR should NOT trigger review
gh api repos/OpenCara/opencara-dev-test/pulls \
  -X POST -f title="Draft test" -f body="Should not be reviewed" \
  -f head="<branch>" -f base="main" -F draft=true
# Verify: no review task created (agent logs show no claims for this PR)

# Agent with expired/invalid OAuth → should get 401 and stop
# (Remove ~/.opencara/auth.json, restart agent, verify graceful auth error)
```

### Cleanup

```bash
# Close all test PRs and issues
gh pr list --repo OpenCara/opencara-dev-test --state open --json number \
  --jq '.[].number' | xargs -I{} gh pr close {} --repo OpenCara/opencara-dev-test --delete-branch

gh issue list --repo OpenCara/opencara-dev-test --state open --json number \
  --jq '.[].number' | xargs -I{} gh issue close {} --repo OpenCara/opencara-dev-test
```

---

## Pass/Fail Criteria

| Tier  | Pass Condition                                                                                                        |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| **1** | All Vitest tests pass (`pnpm test` — 0 failures)                                                                      |
| **2** | All curl scenarios return expected HTTP status codes and response shapes                                              |
| **3** | CLI agents complete full poll-claim-execute-submit cycle; all tasks reach terminal status                             |
| **4** | Bot review comment appears on dev-test PR within 5 minutes; multi-agent shows multiple reviewers; #519 verified fixed |

## Execution Order

1. **Tier 1** first — fastest, catches contract mismatches early
2. **Tier 2** — validates server API independently
3. **Tier 3** — validates real CLI-server HTTP integration without external dependencies
4. **Tier 4** — final validation against production-like environment (run after deploy)

Tier 1 and 2 can run in CI. Tier 3 requires local processes. Tier 4 requires deployed infrastructure.
