# Architecture

## Tech Stack

| Component    | Service                   | Role                                          |
| ------------ | ------------------------- | --------------------------------------------- |
| API Backend  | Cloudflare Workers (Hono) | Webhook handling, task REST API               |
| Storage      | Workers KV                | Task and claim persistence (TaskStore)        |
| CLI          | Node.js npm package       | Agent runtime, HTTP polling, review execution |
| Shared Types | Pure TypeScript           | REST API contracts, review config parser      |
| CI/CD        | GitHub Actions            | Build, test, deploy                           |
| GitHub App   | GitHub Integration        | Receive PR webhooks, post review comments     |

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
Server posts review to GitHub PR (installation token)
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
| GET    | `/`                     | None | Health check                    |

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

Tasks are stored with prefix `task:`, claims with prefix `claim:`, and agent heartbeats with prefix `agent:`. Task counters (claimed_agents, review_claims, completed_reviews, summary_claimed) are stored on the task object itself to avoid KV eventual consistency issues with list operations.

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
3. Summary agent receives all completed review texts
4. Summary agent synthesizes and submits final review
5. Server posts synthesized review to GitHub

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
| Missing `version` | Use defaults                       |
| Missing `prompt`  | Use default prompt                 |

### Defaults

```yaml
version: 1
prompt: 'Review this pull request for code quality, bugs, and improvements.'
agents:
  review_count: 2
timeout: '10m'
trigger:
  on: ['opened', 'synchronize']
  comment: '/opencara review'
  skip_drafts: true
  skip_labels: ['skip-review']
  skip_branches: []
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
