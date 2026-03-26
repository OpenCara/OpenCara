# Architecture

## Tech Stack

| Component    | Service                   | Role                                            |
| ------------ | ------------------------- | ----------------------------------------------- |
| API Backend  | Cloudflare Workers (Hono) | Webhook handling, task REST API                 |
| Storage      | Cloudflare D1 (SQL)       | Task and claim persistence (DataStore)          |
| CLI          | Node.js npm package       | Agent runtime, HTTP polling, review execution   |
| Shared Types | Pure TypeScript           | REST API contracts, review config parser        |
| CI/CD        | GitHub Actions            | Build, test, deploy                             |
| GitHub App   | GitHub Integration        | Receive PR webhooks, post review as PR comments |

### Rationale

- **Hono on Workers**: Portable across Workers, Node, Deno, Bun. Fast webhook response, minimal overhead.
- **D1 (SQL)**: Task coordination with atomic operations. DataStore abstraction supports D1 (production) and in-memory (dev/test).
- **HTTP polling over WebSocket**: Simpler, stateless, no Durable Objects needed. Agents poll every 10s.
- **Minimal persistence**: Tasks stored in D1 (SQL) with TTL-based cleanup. No user accounts, no auth, no reputation tracking (yet).
- **TypeScript across stack**: Server, CLI, and shared types all in TypeScript.

### Core Flow

```
GitHub (PR Webhook)
    ↓
Hono server validates signature, reads .opencara.toml
    ↓
Creates task in D1 (DataStore)
    ↓
Agent polls /api/tasks/poll → sees available task
    ↓
Agent claims task via /api/tasks/:id/claim
    ↓
Agent fetches diff from GitHub (authenticated for private repos)
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

| Method | Path                    | Auth    | Description                     |
| ------ | ----------------------- | ------- | ------------------------------- |
| POST   | `/webhook/github`       | HMAC    | Receive GitHub webhook events   |
| POST   | `/api/tasks/poll`       | API Key | Agent polls for available tasks |
| POST   | `/api/tasks/:id/claim`  | API Key | Agent claims a task slot        |
| POST   | `/api/tasks/:id/result` | API Key | Agent submits review result     |
| POST   | `/api/tasks/:id/reject` | API Key | Agent rejects a claimed task    |
| POST   | `/api/tasks/:id/error`  | API Key | Agent reports execution error   |
| GET    | `/api/registry`         | None    | Tool/model registry             |
| GET    | `/health`               | None    | Health check (status + version) |
| GET    | `/metrics`              | None    | Task count metrics              |
| GET    | `/`                     | None    | Root health check               |

### Poll Flow

```
POST /api/tasks/poll
  Body: { agent_id: "uuid", repos?: ["owner/repo", ...] }
  Response: { tasks: [{ task_id, owner, repo, pr_number, diff_url, timeout_seconds, prompt, role }] }
```

Agent receives a list of available tasks. Each task has a `role` field indicating whether the agent should do a `review` or `summary`. The optional `repos` field declares which repos the agent can access — used by the server to include matching private repo tasks in the response.

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

## DataStore

Abstracted storage interface for tasks, claims, locks, and agent heartbeats.

```typescript
interface DataStore {
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

  // Locks (atomic, for summary dedup)
  acquireLock(key: string, value: string, ttlMs?: number): Promise<boolean>;
  getLock(key: string): Promise<string | null>;

  // Agent last-seen
  setAgentLastSeen(agentId: string, timestamp: number): Promise<void>;
  getAgentLastSeen(agentId: string): Promise<number | null>;
}
```

Implementations:

- **D1DataStore** (`packages/server/src/store/d1.ts`) — Cloudflare D1 (SQL) for production
- **MemoryDataStore** (`packages/server/src/store/memory.ts`) — In-memory for dev/test

### D1 Schema

Tasks, claims, locks, and agent heartbeats are stored in D1 SQL tables. D1DataStore uses atomic transactions for lock acquisition and summary dedup, eliminating eventual consistency race conditions.

**Task counters** (`claimed_agents`, `review_claims`, `completed_reviews`, `reviews_completed_at`) are stored on the task row to enable atomic updates.

### Worker ↔ DataStore Interaction

The Worker is stateless — each request creates a fresh DataStore wrapper:

```
Request → Hono middleware → createStore(env) → inject into context → route handler
```

Store selection: D1DataStore (if `env.DB` present) > MemoryDataStore (fallback).

**Cron trigger** (every minute via `wrangler.toml`): Creates a fresh DataStore, runs `checkTimeouts()` to mark expired tasks as `timeout` and post partial results.

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

For `agent_count > 1` in `.opencara.toml`:

1. `agent_count - 1` agents claim as `review` role
2. After all reviews complete, one agent claims as `summary` role
   - If `summarizer.preferred` is set, preferred agents get the slot immediately
   - Non-preferred agents are held for a 60-second grace period to give preferred agents a chance
   - After the grace period, any eligible agent can claim the slot (first-come-first-served)
3. Summary agent receives all completed review texts
4. Summary agent synthesizes and submits final review
5. Server posts synthesized review as a PR comment

For `agent_count = 1` (single agent):

1. One agent claims as `summary` role directly
2. Agent reviews and submits
3. Server posts review to GitHub

## `.opencara.toml` Configuration

Read from the repository's head branch on each PR webhook.

| Scenario          | Behavior                           |
| ----------------- | ---------------------------------- |
| File not found    | Skip review — repo hasn't opted in |
| Malformed TOML    | Skip review, log error             |
| Missing `version` | Error (required field)             |
| Missing `prompt`  | Error (required field)             |

### Full Schema

```toml
version = 1 # Required

[review]
prompt = """
Review this PR for bugs and security issues.
""" # Required — review instructions for agents
agent_count = 3 # Total agents: (N-1) reviewers + 1 synthesizer (1-10, default: 1)
preferred_models = [] # Preferred AI models (informational, not enforced)
preferred_tools = [] # Preferred AI tools (informational, not enforced)
timeout = "10m" # Task timeout (1m-30m, default: 10m)

[review.trigger]
on = ["opened"] # PR events that trigger review (default: ["opened"])
comment = "/opencara review" # Manual trigger comment (default: /opencara review)
skip = ["draft"] # Skip conditions: "draft", label names, branch names

# Reviewer access control
[[review.reviewer.whitelist]]
github = "trusted-contributor"

[[review.reviewer.blacklist]]
github = "unreliable-reviewer"

# Summarizer (synthesizer) access control
# Also supports string shorthand: summarizer = "alice"
# And object shorthand: [review.summarizer] only = "alice"
[[review.summarizer.whitelist]]
github = "trusted-contributor"

[[review.summarizer.blacklist]]
github = "review-only-user"

[[review.summarizer.preferred]]
github = "best-summarizer"     # Gets summary slot immediately
[[review.summarizer.preferred]]
github = "backup-summarizer"   # Fallback if first is unavailable
```

### Defaults

```toml
version = 1

[review]
prompt = "Review this pull request for bugs, security issues, and code quality."
agent_count = 1
timeout = "10m"

[review.trigger]
on = ["opened"]
comment = "/opencara review"   # Both /opencara and @opencara work
skip = ["draft"]
```

## Error Responses

All API endpoints return structured error responses with machine-readable error codes:

```json
{
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task abc123 not found"
  }
}
```

Error codes: `UNAUTHORIZED`, `TASK_NOT_FOUND`, `CLAIM_CONFLICT`, `CLAIM_NOT_FOUND`, `INVALID_REQUEST`, `RATE_LIMITED`, `INTERNAL_ERROR`, `SUMMARY_LOCKED`.

Types are defined in `packages/shared/src/api.ts` (`ErrorCode`, `ErrorResponse`).

## Rate Limiting

API endpoints are protected by per-IP rate limiting (middleware at `packages/server/src/middleware/rate-limit.ts`). Rate-limited requests receive a `429` status with `RATE_LIMITED` error code.

## Security

| Layer                       | Approach                                                     |
| --------------------------- | ------------------------------------------------------------ |
| GitHub Webhook verification | HMAC-SHA256 signature validation (`X-Hub-Signature-256`)     |
| Agent authentication        | API key (`Authorization: Bearer`) on task endpoints          |
| Review content              | Posted as-is from agent — no server-side moderation          |
| GitHub API access           | Installation tokens (short-lived, scoped to installed repos) |

## Error Handling

### Agent Failure

- Agent sends `/api/tasks/:id/error` or `/api/tasks/:id/reject`
- Task remains in `reviewing` — other agents can still claim available slots
- If all slots fail, task stays in `reviewing` until timeout

### Timeout

- Checked by cron trigger (every minute) via `checkTimeouts()`
- If reviews exist: post partial results as individual comments, then timeout comment
- If no reviews: post timeout-only comment
- Task status → `timeout`

### GitHub API Failure

- Comment post failure → task marked `failed`
- Installation token failure → webhook returns 200 (silent skip)
