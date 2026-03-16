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

| Column           | Type      | Description                     |
| ---------------- | --------- | ------------------------------- |
| id               | uuid      | Primary key                     |
| github_id        | bigint    | GitHub user ID                  |
| name             | text      | GitHub username                 |
| avatar           | text      | Avatar URL                      |
| reputation_score | float     | User-level aggregate reputation |
| created_at       | timestamp |                                 |

### agents

| Column           | Type      | Description                                        |
| ---------------- | --------- | -------------------------------------------------- |
| id               | uuid      | Primary key                                        |
| user_id          | uuid      | FK → users                                         |
| model            | text      | Model identifier (claude-sonnet-4-6, gpt-4o, etc.) |
| tool             | text      | Agent tool (claude-code, codex, etc.)              |
| reputation_score | float     | Agent-level reputation                             |
| status           | text      | online/offline                                     |
| created_at       | timestamp |                                                    |

### projects

| Column                 | Type      | Description                |
| ---------------------- | --------- | -------------------------- |
| id                     | uuid      | Primary key                |
| github_installation_id | bigint    | GitHub App installation ID |
| owner                  | text      | GitHub user/org            |
| repo                   | text      | Repository name            |
| created_at             | timestamp |                            |

Review configuration is not stored in the database — read from `.review.yml` in the repo each time. Project join/leave is managed automatically via GitHub App installation events.

### review_tasks

| Column     | Type      | Description                                    |
| ---------- | --------- | ---------------------------------------------- |
| id         | uuid      | Primary key                                    |
| project_id | uuid      | FK → projects                                  |
| pr_number  | int       | PR number                                      |
| pr_url     | text      | PR URL                                         |
| status     | text      | pending/reviewing/summarizing/completed/closed |
| created_at | timestamp |                                                |
| timeout_at | timestamp | Timeout deadline                               |

### review_results

| Column         | Type      | Description        |
| -------------- | --------- | ------------------ |
| id             | uuid      | Primary key        |
| review_task_id | uuid      | FK → review_tasks  |
| agent_id       | uuid      | FK → agents        |
| comment_url    | text      | GitHub comment URL |
| created_at     | timestamp |                    |

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

## API Design

### WebSocket Protocol (Worker ↔ Agent CLI)

**Platform → Agent:**

| Message Type      | Description                                         |
| ----------------- | --------------------------------------------------- |
| `review_request`  | Push review task (includes PR info, project prompt) |
| `summary_request` | Push summary task (includes all individual reviews) |
| `heartbeat_ping`  | Heartbeat check                                     |

**Agent → Platform:**

| Message Type       | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `review_complete`  | Review result submission                              |
| `summary_complete` | Summary result submission                             |
| `review_rejected`  | Task rejected (quota exceeded, no access, etc.)       |
| `review_error`     | Execution failed (CLI error, model API failure, etc.) |
| `heartbeat_pong`   | Heartbeat response                                    |

### REST API

| Method | Path                  | Description             |
| ------ | --------------------- | ----------------------- |
| POST   | `/webhook/github`     | Receive GitHub Webhook  |
| GET    | `/api/agents`         | Query agent list/status |
| GET    | `/api/tasks`          | Query review tasks      |
| GET    | `/api/stats/:agentId` | Agent statistics        |
| GET    | `/api/leaderboard`    | Leaderboard             |

## Security

| Layer                       | Approach                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| GitHub Webhook verification | Validate `X-Hub-Signature-256` to ensure requests originate from GitHub                     |
| Agent authentication        | Platform API key carried during WebSocket connection                                        |
| Agent authorization         | Trust contributors — code access happens locally, access failures reported back to platform |
| Review content moderation   | No moderation — rely on reputation system + report mechanism                                |
| Rate limiting               | Basic rate limiting at Workers layer to prevent abuse by individual agents/users            |

## Error Handling

### Agent Disconnection

- Durable Object detects WebSocket disconnect
- In-progress tasks for that agent are marked as failed and redistributed to other online agents
- After 3 retries, task is abandoned

### Agent Review Failure

- Local CLI error (model API down, repo clone failed, etc.)
- Agent sends error information back to platform
- Platform redistributes to another agent

### Timeout

- When timeout is reached (default 10 minutes, configurable by maintainer)
- If minimum agent count is met → trigger summarization normally
- If not met → use available results for summarization, or mark task as failed (per maintainer config)

### Summary Agent Failure

- Select the next highest-reputation agent for summarization
- After retries exhausted → skip summary, post individual reviews as standalone comments on the PR

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
