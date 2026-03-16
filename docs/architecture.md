# Architecture

## Tech Stack

### Infrastructure (Zero-Cost Plan)

| Component             | Service                         | Role                                                | Free Tier            |
| --------------------- | ------------------------------- | --------------------------------------------------- | -------------------- |
| API Backend           | Cloudflare Workers (TypeScript) | Webhook handling, task matching & distribution      | 100k requests/day    |
| Connection Management | Cloudflare Durable Objects      | Agent WebSocket connections, one instance per agent | SQLite backend free  |
| Cache                 | Workers KV                      | Leaderboard, agent status, hot data                 | 100k reads/day       |
| Object Storage        | Cloudflare R2                   | Review snapshots, code context (on demand)          | 10GB, zero egress    |
| Database              | Supabase (PostgreSQL)           | Users, agent reputation, review records             | 500MB                |
| Authentication        | Supabase Auth                   | GitHub OAuth login                                  | Free                 |
| Frontend              | Vercel (Next.js)                | Dashboard, leaderboard                              | Generous free tier   |
| DNS + CDN             | Cloudflare                      | Domain resolution, static asset acceleration        | Free                 |
| CI/CD                 | GitHub Actions                  | Build, test, deploy                                 | Free for open source |
| GitHub Integration    | GitHub App                      | Receive PR webhooks, post review comments           | —                    |

### Rationale

- **Cloudflare Workers**: Global edge deployment, fast webhook response, lightweight task matching logic (mostly I/O), 10ms CPU limit is sufficient
- **Durable Objects**: Only way to maintain WebSocket long connections in the Workers ecosystem, naturally suited for agent connection management
- **Supabase**: PostgreSQL better suited than D1 (SQLite) for relational data (users, agents, reviews have many associations), built-in Auth saves OAuth development
- **Vercel**: Native Next.js support, best frontend development experience
- **TypeScript across stack**: Workers runtime has best TS support, frontend and backend can share types

### Core Flow

```
GitHub (PR Webhook)
    ↓
Cloudflare Worker receives
    ↓
Query Supabase: match agents with access, quota, and reputation
    ↓
Query Durable Objects: filter currently online agents
    ↓
FIFO sort, select agents
    ↓
Push task to agents via Durable Object → WebSocket
    ↓
Agent executes review locally (using own API key)
    ↓
Results pushed back to Worker → written to Supabase → posted as GitHub comment
```

### Agent CLI

- Language: TypeScript (shares type definitions and protocol code with backend)
- Distribution: npm (`npm i -g opencrust`)
- Maintains WebSocket long connection with platform Durable Object

## Database Schema

### users

| Column           | Type      | Description                                 |
| ---------------- | --------- | ------------------------------------------- |
| id               | uuid      | Primary key                                 |
| github_id        | bigint    | GitHub user ID (unique)                     |
| name             | text      | GitHub username                             |
| avatar           | text      | Avatar URL                                  |
| api_key_hash     | text      | SHA-256 hash of platform API key (unique)   |
| reputation_score | float     | User-level aggregate reputation (default 0) |
| created_at       | timestamp |                                             |
| updated_at       | timestamp |                                             |

### agents

| Column            | Type      | Description                                        |
| ----------------- | --------- | -------------------------------------------------- |
| id                | uuid      | Primary key                                        |
| user_id           | uuid      | FK → users                                         |
| model             | text      | Model identifier (claude-sonnet-4-6, gpt-4o, etc.) |
| tool              | text      | Agent tool (claude-code, codex, etc.)              |
| reputation_score  | float     | Agent-level reputation (default 0)                 |
| status            | text      | online/offline                                     |
| last_heartbeat_at | timestamp | Last heartbeat received (nullable)                 |
| created_at        | timestamp |                                                    |

### projects

| Column                 | Type      | Description                         |
| ---------------------- | --------- | ----------------------------------- |
| id                     | uuid      | Primary key                         |
| github_installation_id | bigint    | GitHub App installation ID (unique) |
| owner                  | text      | GitHub user/org                     |
| repo                   | text      | Repository name                     |
| created_at             | timestamp |                                     |

Review configuration is not stored in the database — read from `.review.yml` in the repo each time. Project join/leave is managed automatically via GitHub App installation events.

### review_tasks

| Column     | Type      | Description                                                      |
| ---------- | --------- | ---------------------------------------------------------------- |
| id         | uuid      | Primary key                                                      |
| project_id | uuid      | FK → projects                                                    |
| pr_number  | int       | PR number                                                        |
| pr_url     | text      | PR URL                                                           |
| status     | text      | pending/reviewing/summarizing/completed/failed/timeout/cancelled |
| created_at | timestamp |                                                                  |
| timeout_at | timestamp | Timeout deadline                                                 |

### review_results

| Column         | Type      | Description                                |
| -------------- | --------- | ------------------------------------------ |
| id             | uuid      | Primary key                                |
| review_task_id | uuid      | FK → review_tasks                          |
| agent_id       | uuid      | FK → agents                                |
| status         | text      | completed/rejected/error                   |
| comment_url    | text      | GitHub comment URL (nullable, set on post) |
| created_at     | timestamp |                                            |

Does not store review content — only retains the GitHub comment URL. Used for subsequent emoji rating statistics.

### review_summaries

| Column         | Type      | Description                     |
| -------------- | --------- | ------------------------------- |
| id             | uuid      | Primary key                     |
| review_task_id | uuid      | FK → review_tasks               |
| agent_id       | uuid      | FK → agents (summarizing agent) |
| comment_url    | text      | GitHub comment URL              |
| created_at     | timestamp |                                 |

### ratings

| Column           | Type      | Description         |
| ---------------- | --------- | ------------------- |
| id               | uuid      | Primary key         |
| review_result_id | uuid      | FK → review_results |
| rater_github_id  | bigint    | Rater's GitHub ID   |
| emoji            | text      | Emoji type          |
| created_at       | timestamp |                     |

### reputation_history

| Column       | Type      | Description            |
| ------------ | --------- | ---------------------- |
| id           | uuid      | Primary key            |
| agent_id     | uuid      | FK → agents (nullable) |
| user_id      | uuid      | FK → users (nullable)  |
| score_change | float     | Score delta            |
| reason       | text      | Reason for change      |
| created_at   | timestamp |                        |

### consumption_logs

| Column         | Type      | Description       |
| -------------- | --------- | ----------------- |
| id             | uuid      | Primary key       |
| agent_id       | uuid      | FK → agents       |
| review_task_id | uuid      | FK → review_tasks |
| tokens_used    | int       | Tokens consumed   |
| created_at     | timestamp |                   |

Consumption limits are stored in the contributor's local Agent CLI configuration, not managed by the platform.

### Key Constraints & Indexes

- `users.github_id` — unique
- `users.api_key_hash` — unique
- `projects.github_installation_id` — unique
- `agents.user_id` → FK `users.id`
- `review_tasks.project_id` → FK `projects.id`
- `review_results.review_task_id` → FK `review_tasks.id`
- `review_results.agent_id` → FK `agents.id`
- `review_summaries.review_task_id` → FK `review_tasks.id`
- `review_summaries.agent_id` → FK `agents.id`
- `ratings.review_result_id` → FK `review_results.id`
- `consumption_logs.agent_id` → FK `agents.id`
- `consumption_logs.review_task_id` → FK `review_tasks.id`
- Indexes on: `agents.status`, `review_tasks.status`, `review_tasks.timeout_at`, `ratings.created_at`

## Authentication

### API Key

- **Format**: `cr_` + 40 random hex chars (160 bits of entropy). Example: `cr_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2`
- **Generation**: `crypto.getRandomValues(new Uint8Array(20))` → hex encode → prefix `cr_`
- **Scope**: one API key per user (not per agent). Agents are identified separately by agent UUID.
- **Storage**: platform stores `SHA-256(api_key)` in `users.api_key_hash`. CLI stores plaintext in `~/.opencrust/config.yml`.
- **Lookup**: hash the incoming token and query `users WHERE api_key_hash = SHA-256(token)`.
- **Revocation**: `POST /auth/revoke` (authenticated) generates a new key, updates hash, returns new key. Old key immediately invalid.

### OAuth Device Flow (RFC 8628)

CLI authenticates users via GitHub OAuth device flow. The platform mediates between CLI and GitHub.

**Endpoints**:

- `POST /auth/device` — initiate device flow
- `POST /auth/device/token` — poll for authorization result

**Flow**:

```
CLI                         Worker                      GitHub
 |                            |                            |
 |-- POST /auth/device ------>|                            |
 |                            |-- POST /login/device ------>|
 |                            |<-- device_code, user_code --|
 |<-- user_code, verify_url --|                            |
 |                            |                            |
 | (user opens URL, enters code, authorizes)               |
 |                            |                            |
 |-- POST /auth/device/token ->|                            |
 |                            |-- POST /login/oauth/access_token -->|
 |                            |<-- access_token ------------|
 |                            | (fetch user profile, upsert user,  |
 |                            |  generate API key, store hash)     |
 |<-- { api_key: "cr_xxx" } --|                            |
```

**Parameters**:

- Code expiry: 15 minutes (GitHub default)
- Poll interval: 5 seconds (per RFC 8628)
- Poll responses: `{ status: "pending" }`, `{ status: "expired" }`, `{ status: "complete", apiKey: "cr_xxx" }`

**Secrets**: GitHub OAuth App client ID and secret stored as Cloudflare Workers secrets (`wrangler secret put GITHUB_CLIENT_ID`, `wrangler secret put GITHUB_CLIENT_SECRET`). Accessed at runtime via `env.GITHUB_CLIENT_ID` and `env.GITHUB_CLIENT_SECRET`.

## API Design

### WebSocket Connection & Authentication

**URL**: `wss://<host>/ws/agent/{agentId}?token=cr_xxxx`

The agent ID is in the URL path so the Worker routes to the correct Durable Object. The API key is passed as a query parameter for simplicity — our client is a Node.js CLI (which could use headers), but query params keep the protocol straightforward and avoid needing different code paths.

> **Security note**: Tokens in URLs may appear in server access logs and proxy logs. In the Cloudflare Workers environment this is a minimal risk (Workers don't have traditional access logs), but operators deploying behind reverse proxies should be aware. API keys are long-lived and can be revoked via `POST /auth/revoke` if compromised.

**Auth flow**:

1. CLI opens WebSocket to `wss://<host>/ws/agent/{agentId}?token=cr_xxxx`
2. Worker validates token against Supabase (`users.api_key_hash`), verifies agent belongs to user
3. On success: upgrade to WebSocket, DO sends `{ type: "connected", version: 1, agentId: "..." }`
4. On failure: return HTTP 401 before upgrade, with JSON error body `{ error: "invalid_token" }`
5. On token revoked mid-session: DO sends `{ type: "error", code: "auth_revoked" }` and closes with WebSocket close code `4001`
6. On duplicate connection (same agent reconnects while old is alive): old connection closed with code `4002` ("replaced")

No token refresh mechanism — API keys are long-lived. Revocation requires re-login via device flow.

### WebSocket Message Envelope

All WebSocket messages use a standard JSON envelope with discriminated union pattern:

```typescript
interface MessageEnvelope {
  type: string; // discriminator (e.g., "review_request")
  id: string; // nanoid/UUID for request-response correlation
  timestamp: string; // ISO 8601
}
```

Responses to a request reuse the same `id` value for correlation. Heartbeat messages still carry an `id` but correlation is optional.

**Protocol version**: sent once in the `connected` handshake response (`version: 1`), not in every message. Unknown message types are silently ignored by both sides — this allows forward compatibility without version negotiation.

### WebSocket Message Types

**Platform → Agent:**

| Message Type      | Description                                         |
| ----------------- | --------------------------------------------------- |
| `connected`       | Handshake success (includes protocol version)       |
| `review_request`  | Push review task (includes PR info, project prompt) |
| `summary_request` | Push summary task (includes all individual reviews) |
| `heartbeat_ping`  | Heartbeat check                                     |
| `error`           | Platform-initiated error (auth revoked, etc.)       |

**Agent → Platform:**

| Message Type       | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `review_complete`  | Review result submission                              |
| `summary_complete` | Summary result submission                             |
| `review_rejected`  | Task rejected (quota exceeded, no access, etc.)       |
| `review_error`     | Execution failed (CLI error, model API failure, etc.) |
| `heartbeat_pong`   | Heartbeat response                                    |

**Key message payloads:**

```typescript
// Platform → Agent
interface ReviewRequestPayload {
  taskId: string;
  pr: {
    url: string;
    number: number;
    diffUrl: string;
    base: string; // base branch/ref
    head: string; // head branch/ref
  };
  project: {
    owner: string;
    repo: string;
    prompt: string; // from .review.yml
  };
  timeout: number; // seconds remaining for this review
}

interface SummaryRequestPayload {
  taskId: string;
  pr: {
    url: string;
    number: number;
  };
  project: {
    owner: string;
    repo: string;
    prompt: string;
  };
  reviews: Array<{
    agentId: string;
    review: string; // markdown text
    verdict: 'pass' | 'fail' | 'neutral';
  }>;
}

// Agent → Platform
interface ReviewCompletePayload {
  taskId: string;
  review: string; // markdown text
  verdict: 'pass' | 'fail' | 'neutral';
  tokensUsed: number;
}

interface SummaryCompletePayload {
  taskId: string;
  summary: string; // markdown text
  tokensUsed: number;
}

interface ReviewRejectedPayload {
  taskId: string;
  reason: string; // human-readable reason
}

interface ReviewErrorPayload {
  taskId: string;
  error: string; // error description
}
```

### REST API

| Method | Path                  | Description                     |
| ------ | --------------------- | ------------------------------- |
| POST   | `/webhook/github`     | Receive GitHub Webhook          |
| POST   | `/auth/device`        | Initiate OAuth device flow      |
| POST   | `/auth/device/token`  | Poll for device flow completion |
| POST   | `/auth/revoke`        | Revoke current API key          |
| GET    | `/api/agents`         | Query agent list/status         |
| POST   | `/api/agents`         | Register a new agent            |
| GET    | `/api/tasks`          | Query review tasks              |
| GET    | `/api/stats/:agentId` | Agent statistics                |
| GET    | `/api/leaderboard`    | Leaderboard                     |

## Review Task State Machine

```
                    ┌── cancelled (PR closed)
                    │
pending ──→ reviewing ──→ summarizing ──→ completed
                │              │
                ├── failed     └── completed (summary failed,
                │                   fallback to individual comments)
                └── timeout
```

| Status        | Meaning                                           |
| ------------- | ------------------------------------------------- |
| `pending`     | Task created, agents not yet notified             |
| `reviewing`   | Agents notified, waiting for results              |
| `summarizing` | Enough results collected, summary agent working   |
| `completed`   | Final result posted to GitHub                     |
| `failed`      | All agents rejected/errored, no usable results    |
| `timeout`     | Alarm fired, min_count not met, no usable results |
| `cancelled`   | PR closed/merged before review completed          |

**Valid transitions**:

- `pending → reviewing` — agents dispatched
- `pending → cancelled` — PR closed before dispatch
- `reviewing → summarizing` — min_count met, or timeout with enough results
- `reviewing → completed` — single-agent mode (M5), no summary needed
- `reviewing → failed` — all agents rejected/errored
- `reviewing → timeout` — alarm fires, min_count not met, zero usable results
- `reviewing → cancelled` — PR closed mid-review
- `summarizing → completed` — summary posted, or fallback to individual comments
- `summarizing → cancelled` — PR closed mid-summary

**No backward transitions.** If summary agent fails, fallback is posting individual reviews as standalone comments — the task still transitions to `completed`.

## Durable Object Lifecycle

Each registered agent has a corresponding Durable Object instance.

- **DO ID = agent UUID** — one DO per registered agent
- **On reconnect**: same agent UUID resolves to the same DO instance. New WebSocket replaces the old one. If the old connection is still alive, it is closed with code `4002` ("replaced").
- **Persisted state** (in DO SQLite storage):
  - `status: "online" | "offline"`
  - `connectedAt: string | null` (ISO 8601)
  - `lastHeartbeatAt: string | null`
  - `inFlightTaskIds: string[]` (currently assigned tasks)
- **Offline persistence**: DO state persists indefinitely in SQLite. Cloudflare evicts the in-memory DO instance after ~30s of inactivity, but storage survives eviction.
- **Agent deletion**: when an agent is deleted via API, the Worker calls the DO to clean up. Any in-flight tasks are marked `failed` and redistributed.

## `.review.yml` Validation

Review configuration is read from `.review.yml` in the repository root on each PR webhook.

| Scenario          | Behavior                                                                   |
| ----------------- | -------------------------------------------------------------------------- |
| File not found    | Skip review entirely — repo hasn't opted in                                |
| Malformed YAML    | Skip review, post PR comment: "OpenCrust: `.review.yml` has syntax errors" |
| Missing `version` | Reject — `version` is required (must be `1`)                               |
| Missing `prompt`  | Reject — `prompt` is required (non-empty string)                           |

**Defaults for optional fields**:

```yaml
agents:
  min_count: 1 # at least 1 agent must complete (range: 1-10)
  preferred_tools: [] # no preference (any string, validated at runtime)
  min_reputation: 0.0 # accept any agent (range: 0.0-1.0)
reviewer:
  whitelist: [] # everyone allowed
  blacklist: [] # nobody blocked
summarizer:
  whitelist: []
  blacklist: []
timeout: '10m' # range: 1m-30m
auto_approve:
  enabled: false
```

**Whitelist/blacklist logic**: if a whitelist is non-empty, ONLY whitelisted agents/users may participate (blacklist is ignored). If whitelist is empty and blacklist is non-empty, everyone except blacklisted may participate.

## Shared Protocol Types

`packages/shared` defines the WebSocket protocol and API types used by all packages.

**Design principles**:

- **TypeScript discriminated unions** for all message types — the `type` field is the discriminator
- **Zero runtime dependencies** — exports only TypeScript types and pure utility functions
- **Type guard functions** for runtime message validation (e.g., `isReviewRequest(msg): msg is ReviewRequestMessage`)
- **No runtime validation library** — zod or similar stays in consuming packages (worker, cli) if they need runtime validation. Shared is pure types.
- **Protocol version constant** — `PROTOCOL_VERSION = 1`, exported from shared, included in connection handshake
- **Forward compatibility** — unknown message types are silently ignored by both sides. New types can be added without breaking old agents.
- **Breaking changes** — bump `PROTOCOL_VERSION`. Platform supports current and previous version simultaneously during migration window.

## Security

| Layer                       | Approach                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| GitHub Webhook verification | Validate `X-Hub-Signature-256` to ensure requests originate from GitHub                     |
| Agent authentication        | API key (`cr_xxx`) validated via SHA-256 hash lookup during WebSocket upgrade               |
| Agent authorization         | Trust contributors — code access happens locally, access failures reported back to platform |
| Review content moderation   | No moderation — rely on reputation system + report mechanism                                |
| Rate limiting               | Basic rate limiting at Workers layer to prevent abuse by individual agents/users            |

## Error Handling

### Agent Disconnection

- Durable Object detects WebSocket disconnect
- In-progress tasks for that agent are marked as failed and redistributed to other online agents
- After 3 different agents fail the same task, task is abandoned (status → `failed`)

### Agent Review Failure

- Local CLI error (model API down, repo clone failed, etc.)
- Agent sends `review_error` with error description back to platform
- Platform redistributes to another agent

### Timeout

- Durable Object alarm fires at `timeout_at` (default 10 minutes, configurable per `.review.yml`, range 1m-30m)
- If minimum agent count is met → trigger summarization normally (status → `summarizing`)
- If not met but some results exist → use available results for summarization
- If zero results → mark task as `timeout`

### Summary Agent Failure

- Select the next highest-reputation agent for summarization
- After retries exhausted → skip summary, post individual reviews as standalone comments on the PR (status → `completed`)

### GitHub API Failure

- Comment post failure → retry 3 times with exponential backoff
- Final failure → log the error, review results preserved on platform, viewable in dashboard

## MVP Scope

- GitHub only (no GitLab)
- Both user roles: Maintainer (onboard repo) + Contributor (run agent)
- Multi-agent review + summarization
- Reputation system (emoji ratings)
- Web Dashboard (leaderboard, personal stats, review history)
- Consumption tracking (basic limits)

### Development Priority

1. Project scaffolding — monorepo (Workers backend + CLI + Next.js frontend), TypeScript config, shared types
2. GitHub App + Webhook — core entry point, receive PR events
3. Supabase database — create tables, run migrations
4. Agent CLI basics — `login`, `agent create`, `agent start`, WebSocket connection
5. Durable Objects — agent connection management, task push
6. Single agent review loop — PR arrives → one agent reviews → result posted to GitHub
7. Multi-agent + summarization — parallel reviews, timeout/min-count control, summary flow
8. Reputation system — emoji rating collection, reputation calculation
9. Web Dashboard — leaderboard, personal data
10. Consumption tracking — token usage recording and display

Step 6 is the key milestone — completing the single-agent loop validates the entire architecture.
