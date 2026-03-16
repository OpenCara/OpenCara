# MVP Plan

## Goal

Complete a working end-to-end loop: a PR is opened → multiple agents review it → results are summarized and posted to GitHub.

## Milestones

### M0: Project Scaffolding

**Deliverable**: Monorepo with all packages buildable.

- [ ] Initialize monorepo (turborepo or npm workspaces)
  - `packages/worker` — Cloudflare Workers backend
  - `packages/cli` — Agent CLI (npm package)
  - `packages/web` — Next.js frontend
  - `packages/shared` — Shared types and protocol definitions
- [ ] TypeScript config across all packages
- [ ] ESLint + Prettier
- [ ] GitHub Actions CI (lint + typecheck + build)

### M1: GitHub App + Webhook

**Deliverable**: Platform receives PR events from GitHub.

- [ ] Create GitHub App (permissions: pull requests read/write, issues read)
- [ ] Workers endpoint `POST /webhook/github`
- [ ] Validate `X-Hub-Signature-256`
- [ ] Parse `pull_request.opened` and `pull_request.synchronize` events
- [ ] Read `.review.yml` from the repo via GitHub API
- [ ] Store project on GitHub App installation/uninstallation events

### M2: Database + Auth

**Deliverable**: Users can register, agents can be created.

- [ ] Supabase project setup
- [ ] Database migration: `users`, `agents`, `projects`, `review_tasks`, `review_results`, `review_summaries`, `ratings`, `reputation_history`, `consumption_logs`
- [ ] GitHub OAuth device flow integration
  - Platform endpoint to initiate device flow
  - Platform endpoint to poll for authorization
  - Issue platform API key (`cr_xxx`) on success
- [ ] REST API: `GET /api/agents`, `POST /api/agents`

### M3: Agent CLI — Connect

**Deliverable**: CLI can authenticate and maintain a live connection to the platform.

- [ ] `opencrust login` — Initiate GitHub OAuth device flow, store API key to `~/.opencrust/config.yml`
- [ ] `opencrust agent create` — Register agent (select model + tool), calls `POST /api/agents`
- [ ] `opencrust agent list` — List registered agents
- [ ] `opencrust agent start` — Connect to platform via WebSocket, authenticate with API key
- [ ] Heartbeat ping/pong
- [ ] Reconnect on disconnect with exponential backoff

### M4: Durable Objects — Task Distribution

**Deliverable**: Platform can push tasks to connected agents.

- [ ] Durable Object per agent for WebSocket management
- [ ] On new PR webhook:
  1. Read `.review.yml` from repo
  2. Query Supabase for eligible agents (online, has access, meets reputation threshold)
  3. FIFO select agents
  4. Push `review_request` to each agent's Durable Object
- [ ] Create `review_task` record with status `reviewing`
- [ ] Set timeout alarm (default 10 minutes)

### M5: Single Agent Review Loop

**Deliverable**: One agent receives a task, reviews locally, result appears on GitHub. **Key milestone — validates the entire architecture.**

- [ ] CLI receives `review_request` via WebSocket
- [ ] CLI clones/fetches the repo locally (respecting contributor's git access)
- [ ] CLI invokes the configured tool (e.g., `claude`, `codex`) with:
  - PR diff
  - Project prompt from `.review.yml`
  - Repo context (if needed)
- [ ] CLI sends `review_complete` back to platform (includes review text + pass/fail + token usage)
- [ ] Worker posts review as a GitHub PR comment
- [ ] Worker saves `review_result` (comment URL only) and `consumption_log`
- [ ] Handle `review_rejected` and `review_error` from agent
- [ ] CLI reports local consumption stats after each review

### M6: Multi-Agent + Summarization

**Deliverable**: Multiple agents review a PR in parallel, a high-reputation agent summarizes.

- [ ] Distribute `review_request` to multiple agents simultaneously
- [ ] Collect results as agents complete
- [ ] Timeout handling:
  - On timeout, proceed with available results if `min_count` is met
  - Otherwise mark task as failed
- [ ] Select highest-reputation agent, send `summary_request` with all individual reviews
- [ ] Agent returns `summary_complete`
- [ ] Post to GitHub PR:
  - Review thread body = summary
  - Thread comments = individual agent reviews
- [ ] Update task status: `reviewing` → `summarizing` → `completed`
- [ ] Handle summary agent failure (retry with next highest-reputation agent, fallback to individual comments only)
- [ ] Reviewer/summarizer whitelist/blacklist filtering

### M7: Reputation System

**Deliverable**: Maintainers can rate reviews, agent reputation updates accordingly.

- [ ] Listen for GitHub `issue_comment` reaction events (👍 👎 on review comments)
- [ ] Match reactions to `review_results` via comment URL
- [ ] Store ratings: emoji, rater GitHub ID
- [ ] Calculate agent reputation using Wilson confidence interval
- [ ] Calculate user reputation as weighted average of agent reputations
- [ ] Record reputation changes in `reputation_history`
- [ ] Report mechanism — endpoint to flag malicious reviews

### M8: Web Dashboard

**Deliverable**: Public leaderboard and personal stats page.

- [ ] Next.js app deployed on Vercel
- [ ] GitHub OAuth login (shared with CLI auth)
- [ ] Pages:
  - `/` — Landing page with project description
  - `/leaderboard` — Public agent and user rankings
  - `/dashboard` — Personal stats (login required): review history, ratings received, token consumption
  - `/projects` — List of projects using OpenCrust
- [ ] API integration with Workers backend

### M9: Consumption Tracking

**Deliverable**: Contributors can see how much they've spent.

- [ ] `opencrust stats` CLI command — display review count, tokens used, ratings received
- [ ] Dashboard consumption charts (daily/weekly/monthly)
- [ ] Local consumption limits enforcement in CLI:
  - Token budget + reset period
  - Per-project limits
  - Review count caps
- [ ] CLI notifies contributor after each review: tokens used, cumulative, remaining budget

## Acceptance Criteria

The MVP is complete when:

1. A maintainer can install the GitHub App and have PRs automatically reviewed
2. A contributor can run `opencrust login && opencrust agent create && opencrust agent start` and begin reviewing
3. Multiple agents review a PR in parallel with a consolidated summary
4. Maintainers can rate reviews with emoji, affecting agent reputation
5. A web dashboard shows leaderboard and personal stats
6. Contributors can track and limit their token consumption
