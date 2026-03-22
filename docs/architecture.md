# Architecture

## Tech Stack

| Component    | Service                   | Role                                            |
| ------------ | ------------------------- | ----------------------------------------------- |
| API Backend  | Cloudflare Workers (Hono) | Webhook handling, task REST API                 |
| Storage      | Workers KV                | Task and claim persistence (TaskStore)          |
| CLI          | Node.js npm package       | Agent runtime, HTTP polling, review execution   |
| Shared Types | Pure TypeScript           | REST API contracts, review config parser        |
| CI/CD        | GitHub Actions            | Build, test, deploy                             |
| GitHub App   | GitHub Integration        | Receive PR webhooks, post review as PR comments |

### Rationale

- **Hono on Workers**: Portable across Workers, Node, Deno, Bun. Fast webhook response, minimal overhead.
- **Workers KV**: Simple key-value storage for tasks and claims. No database needed at current scale.
- **HTTP polling over WebSocket**: Simpler, stateless, no Durable Objects needed. Agents poll every 10s.
- **No database**: Tasks are ephemeral (KV TTL). No user accounts, no auth, no reputation tracking (yet).
- **TypeScript across stack**: Server, CLI, and shared types all in TypeScript.

### Core Flow

```
GitHub (PR Webhook)
    ↓
Hono server validates signature, reads .review.yml
    ↓
Creates task in KV (TaskStore)
    ↓
Agent polls /api/tasks/poll → sees available task
    ↓
Agent claims task via /api/tasks/:id/claim
    ↓
Agent fetches diff from GitHub (public URL)
    ↓
Agent executes review locally (using own AI tool + API key)
    ↓
Agent submits result via /api/tasks/:id/result
    ↓
Server posts review as PR comment (installation token)
```

### Agent CLI

- Language: TypeScript
- Distribution: npm (`npm i -g opencara`)
- Connection: HTTP polling (10s interval) — no WebSocket
- Review execution: stdin-based command invocation (claude, codex, gemini, qwen)
- Router mode: acts as an AI tool that relays prompts via stdin/stdout

## REST API

| Method | Path                    | Auth | Description                     |
| ------ | ----------------------- | ---- | ------------------------------- |
| POST   | `/webhook/github`       | HMAC | Receive GitHub webhook events   |
| POST   | `/api/tasks/poll`       | None | Agent polls for available tasks |
| POST   | `/api/tasks/:id/claim`  | None | Agent claims a task slot        |
| POST   | `/api/tasks/:id/result` | None | Agent submits review result     |
| POST   | `/api/tasks/:id/reject` | None | Agent rejects a claimed task    |
| POST   | `/api/tasks/:id/error`  | None | Agent reports execution error   |
| GET    | `/api/registry`         | None | Tool/model registry             |
| GET    | `/health`               | None | Health check (status + version) |
| GET    | `/metrics`              | None | Task count metrics              |
| GET    | `/`                     | None | Root health check               |

### Poll Flow

```
POST /api/tasks/poll
  Body: { agent_id: "uuid" }
  Response: { tasks: [{ task_id, owner, repo, pr_number, diff_url, timeout_seconds, prompt, role }] }
```

Agent receives a list of available tasks. Each task has a `role` field indicating whether the agent should do a `review` or `summary`.

### Claim Flow

```
POST /api/tasks/:taskId/claim
  Body: { agent_id, role, model?, tool? }
  Response: { claimed: true, reviews?: [...] } | { claimed: false, reason: "..." }
```

For summary claims, the response includes completed review texts from other agents.

### Result Flow

```
POST /api/tasks/:taskId/result
  Body: { agent_id, type: "review"|"summary", review_text, verdict?, tokens_used? }
  Response: { success: true }
```

When a summary result is submitted, the server posts the final review to GitHub.

## TaskStore

Abstracted storage interface for tasks, claims, and agent heartbeats.

```typescript
interface TaskStore {
  // Tasks
  createTask(task: ReviewTask): Promise<void>;
  getTask(id: string): Promise<ReviewTask | null>;
  listTasks(filter?: TaskFilter): Promise<ReviewTask[]>;
  updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean>;
  deleteTask(id: string): Promise<void>;

  // Claims
  createClaim(claim: TaskClaim): Promise<void>;
  getClaim(claimId: string): Promise<TaskClaim | null>;
  getClaims(taskId: string): Promise<TaskClaim[]>;
  updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void>;

  // Agent last-seen
  setAgentLastSeen(agentId: string, timestamp: number): Promise<void>;
  getAgentLastSeen(agentId: string): Promise<number | null>;
}
```

Implementations:

- **KVTaskStore** (`packages/server/src/store/kv.ts`) — Workers KV for production
- **MemoryTaskStore** (`packages/server/src/store/memory.ts`) — In-memory for dev/test

### KV Key Schema

| Key Pattern | Value | TTL | Purpose |
|-------------|-------|-----|---------|
| `task:{id}` | ReviewTask JSON | 7 days (terminal) | Task data (PR info, status, review count, counters) |
| `claim:{taskId}:{agentId}` | TaskClaim JSON | 7 days (terminal) | Agent's claim on a task (role, status, review text) |
| `agent:{agentId}` | Last-seen timestamp (string) | None | Agent heartbeat tracking |
| `summary-lock:{taskId}` | Agent ID (string) | 7 days | Lock to prevent duplicate summary claims |

**Task metadata** (stored on KV entry for fast `list()` filtering):
```json
{ "status": "pending|reviewing|completed|timeout|failed", "timeout_at": 1711234567890 }
```

**Task enumeration** uses `kv.list({ prefix: "task:" })` with metadata filtering instead of a shared index, eliminating race conditions on concurrent creates/deletes.

**Task counters** (`claimed_agents`, `review_claims`, `completed_reviews`, `summary_claimed`, `reviews_completed_at`) are stored on the task object itself to avoid KV eventual consistency issues with list operations.

**Summary dedup** uses defense-in-depth: KV lock key at claim time (first writer wins) + task completion check at post time. See [#276](https://github.com/OpenCara/OpenCara/issues/276) for known limitations of KV-based locking.

### Worker ↔ KV Interaction

The Worker is stateless — each request creates a fresh `KVTaskStore` wrapper around the `TASK_STORE` KV binding:

```
Request → Hono middleware → KVTaskStore(env.TASK_STORE) → inject into context → route handler
```

| Operation | KV Call | Trigger |
|-----------|---------|---------|
| Create task | `kv.put("task:{id}", json, { metadata })` | Webhook receives PR event |
| List tasks | `kv.list({ prefix: "task:" })` + metadata filter | Agent polls for work |
| Get task | `kv.get("task:{id}")` | Claim, result, timeout check |
| Update task | `kv.put("task:{id}", json, { metadata })` | Status changes, counter updates |
| Create claim | `kv.put("claim:{taskId}:{agentId}", json)` | Agent claims a task |
| List claims | `kv.list({ prefix: "claim:{taskId}:" })` + get each | Summary role needs review texts |
| Lock summary | `kv.put("summary-lock:{taskId}", agentId)` | First summary claim attempt |
| Agent heartbeat | `kv.put("agent:{agentId}", timestamp)` | Every poll request |

**Cron trigger** (every minute via `wrangler.toml`): Creates a fresh `KVTaskStore`, runs `checkTimeouts()` to mark expired tasks as `timeout` and post partial results.

**No connection pooling** — each Worker isolate is stateless. KV is managed by Cloudflare; the Worker calls `get`/`put`/`list`/`delete` on the binding.

### KV Consistency Model

Workers KV is **eventually consistent** (up to 60s propagation). Key implications:

- **Reads may be stale**: A value written in one isolate may not be visible in another for up to 60s
- **No atomic operations**: No compare-and-swap, no conditional writes, `put` always succeeds
- **Write rate limit**: 1 write/sec per key
- **Mitigations**: Task counters stored on the task object (single key), summary lock as best-effort defense, polling interval (10s) naturally buffers propagation delays

## Review Task Lifecycle

```
pending ──→ reviewing ──→ completed
               │
               ├── timeout (alarm-based, with partial review fallback)
               └── failed (all agents errored)
```

| Status      | Meaning                                  |
| ----------- | ---------------------------------------- |
| `pending`   | Task created, no agents have claimed yet |
| `reviewing` | At least one agent has claimed the task  |
| `completed` | Final review posted to GitHub            |
| `timeout`   | Timed out, partial results posted        |
| `failed`    | All agents failed/errored                |

### Multi-Agent Flow

For `review_count > 1` in `.review.yml`:

1. `review_count - 1` agents claim as `review` role
2. After all reviews complete, one agent claims as `summary` role
   - If `summarizer.preferred` is set, preferred agents get the slot immediately
   - Non-preferred agents are held for a 60-second grace period to give preferred agents a chance
   - After the grace period, any eligible agent can claim the slot (first-come-first-served)
3. Summary agent receives all completed review texts
4. Summary agent synthesizes and submits final review
5. Server posts synthesized review as a PR comment

For `review_count = 1` (single agent):

1. One agent claims as `summary` role directly
2. Agent reviews and submits
3. Server posts review to GitHub

## `.review.yml` Configuration

Read from the repository's head branch on each PR webhook.

| Scenario          | Behavior                           |
| ----------------- | ---------------------------------- |
| File not found    | Skip review — repo hasn't opted in |
| Malformed YAML    | Skip review, log error             |
| Missing `version` | Error (required field)             |
| Missing `prompt`  | Error (required field)             |

### Full Schema

```yaml
version: 1 # Required
prompt: | # Required — review instructions for agents
  Review this PR for bugs and security issues.

agents:
  review_count: 3 # Total agents: (N-1) reviewers + 1 synthesizer (1-10, default: 1)
  preferred_models: [] # Preferred AI models (informational, not enforced)
  preferred_tools: [] # Preferred AI tools (informational, not enforced)

timeout: 10m # Task timeout (1m-30m, default: 10m)

trigger:
  on: [opened] # PR events that trigger review (default: [opened])
  comment: '/opencara review' # Manual trigger comment (default: /opencara review)
  skip: [draft] # Skip conditions: "draft", label names, branch names

# Reviewer access control
reviewer:
  whitelist: # Only these agents/users can review (empty = all allowed)
    - agent: agent-abc123
    - user: alice
  blacklist: # Block specific agents/users from reviewing
    - agent: agent-spammy999
  allow_anonymous: true # Allow agents without accounts (default: true)

# Summarizer (synthesizer) access control
summarizer:
  whitelist: # Only these agents/users can synthesize
    - agent: agent-abc123
  blacklist: # Block specific agents/users from synthesizing
    - agent: agent-xyz789
  preferred: # Ordered preference for synthesis role
    - agent: agent-abc123 # Gets summary slot immediately
    - agent: agent-def456 # Fallback if first is unavailable
```

### Defaults

```yaml
version: 1
prompt: 'Review this pull request for bugs, security issues, and code quality.'
agents:
  review_count: 1
timeout: '10m'
trigger:
  on: ['opened']
  comment: '/opencara review'
  skip: ['draft']
reviewer:
  whitelist: []
  blacklist: []
  allow_anonymous: true
summarizer:
  whitelist: []
  blacklist: []
  preferred: []
```

## Security

| Layer                       | Approach                                                     |
| --------------------------- | ------------------------------------------------------------ |
| GitHub Webhook verification | HMAC-SHA256 signature validation (`X-Hub-Signature-256`)     |
| Agent authentication        | None (open polling) — agents self-identify by UUID           |
| Review content              | Posted as-is from agent — no server-side moderation          |
| GitHub API access           | Installation tokens (short-lived, scoped to installed repos) |

## Error Handling

### Agent Failure

- Agent sends `/api/tasks/:id/error` or `/api/tasks/:id/reject`
- Task remains in `reviewing` — other agents can still claim available slots
- If all slots fail, task stays in `reviewing` until timeout

### Timeout

- Checked lazily on each poll request
- If reviews exist: post partial results as individual comments, then timeout comment
- If no reviews: post timeout-only comment
- Task status → `timeout`

### GitHub API Failure

- Comment post failure → task marked `failed`
- Installation token failure → webhook returns 200 (silent skip)
