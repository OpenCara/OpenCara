# OpenCara

Orchestration layer between AI agents and GitHub (extensible to other platforms).

OpenCara receives webhook events from GitHub, coordinates agents driven by those events, and writes results back to the platform.

Example flows:

- Issue moves from `backlog` → `ready` on a GitHub Projects v2 board → dispatch the implement agent (built-in template `issue-implement`).
- PR opened → start a reviewer agent → after review posted, ask the dev agent to address feedback (built-in template `pr-review`).

## Architecture

| Package | Purpose |
| --- | --- |
| `packages/shared` | Shared TS types and wire-protocol contracts. Published to npm as `@opencara/shared`. |
| `packages/flows` | Built-in flow definitions + Zod schemas for the orchestrator's DAG types. |
| `packages/orchestrator` | Hono server: webhook ingestion, event-driven agent dispatch, persistent state (Postgres + Drizzle). |
| `packages/cli` | Agent-host CLI. Daemon that registers a machine with the orchestrator and runs dispatched agent subprocesses. Published as [`opencara`](https://www.npmjs.com/package/opencara) (`npm i -g opencara` → `opencara` binary; runs the pair flow on first start, then accepts jobs). Think: GitHub Actions self-hosted runners. |
| `apps/web` | React + React Flow UI for visualizing and editing orchestration flows. |

## Stack

- TypeScript end-to-end
- pnpm workspaces
- Hono (orchestrator API)
- PostgreSQL + Drizzle ORM
- Vite + React + React Flow (web UI)
- Node.js ≥ 22

## Development

```bash
pnpm install

# 1. Start postgres (port 5433, named volume)
podman-compose up -d        # or: docker compose up -d

# 2. Run migrations
pnpm --filter @opencara/orchestrator db:migrate

# 3. Run all packages in watch mode
pnpm dev

# Other tasks
pnpm typecheck
pnpm build
```

Default local postgres: `postgres://opencara:opencara@localhost:5433/opencara`. Copy `.env.example` to `packages/orchestrator/.env` and fill in `GITHUB_WEBHOOK_SECRET`.

## GitHub App permissions and events

For the built-in flows to work end-to-end, the GitHub App needs:

- **Repository permissions:** `Issues: read & write`, `Pull requests: read & write`, `Metadata: read`, `Contents: read & write`.
- **Organization permissions:** `Projects: read` (required for the `issue-implement` flow to receive `projects_v2_item` events).
- **Subscribed events:** `Pull request`, `Issues`, `Projects v2 item`, `Installation`, `Installation repositories`.

The `Issues` and `Projects v2 item` subscriptions drive the Issues tab on the project page (issue rows are normalized from the webhook + a one-shot REST backfill on project add) and the `issue-implement` flow template (Projects v2 status changes).

## Agent runtime credentials

Each agent run dispatched through a flow gets an ephemeral GitHub App installation token injected into its environment, so `gh` and any octokit-based tool work out of the box without per-host `gh auth login`:

- `GH_TOKEN`, `GITHUB_TOKEN` — same value, ≤1h TTL, scoped to the project's repo with `contents: write, issues: write, pull_requests: write` (`contents: write` is needed for agent flows like `issue-implement` that push branches).
- `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` — pinned to `opencara[bot]` so commits attribute to the App and don't leak the host's global `~/.gitconfig` identity into the run.

The token is minted per run and revoked when the agent finishes. Identity inside the agent: `gh api user` returns `apps/<slug>` (the App's bot identity); the persisted `agent_runs.spec.env` shows `<ephemeral>` for the token fields rather than the secret.

Limitations (v1):

- No refresh — runs longer than ~1h hit a 401 on late `gh` calls. Most agent runs finish in minutes.
- The smoke-test endpoint (`POST /api/agents/:id/test`) does not inject a token; test runs already see `OPENCARA_TEST=1`.

## Flow node kinds

In addition to `agent` and the existing `github.{post_review,add_comment,add_label}` actions, the flow engine ships two nodes for the issue → implement → PR pipeline:

- **`git.create_worktree`** — runs on a paired device. Allocates an isolated `git clone` of the project repo under the device's tmpdir, branches off `fromBranch` (default: repo default), and emits a `{workdir, branch}` handle. Downstream `agent` nodes inherit `cwd` and the device pin (so the implementer agent runs *inside* the checkout); the worktree is removed at end-of-run regardless of success/failure.
- **`github.create_pull_request`** — opens a PR using the upstream worktree's branch as the head. Title and body support `{{ENV_VAR}}` templates (env vars seen by the run, e.g. `OPENCARA_ISSUE_NUMBER`). Body defaults to the upstream agent's stdout.

Both nodes are wired into the built-in `issue-implement` flow template.

The worktree node uses the CLI's `opencara internal worktree {create,remove,write-session}` subcommands. **Paired devices must be running a CLI build that includes these subcommands** — older CLIs will fail the worktree step with `unknown command: internal`. Rebuild + redeploy `opencara` on each paired host after upgrading the orchestrator.

## Agent kinds (resumable agents)

`agents.kind` selects how the orchestrator invokes an agent at dispatch time. Four named kinds get **per-run conversation resume** — the second iteration on the same PR (e.g. when a reviewer leaves a review) wakes the agent up at the same point in the conversation, on the same device, with its prior plan/scratchpad intact:

| Kind | Binary | Resume model |
|---|---|---|
| `claude` | `claude` | Orchestrator generates a UUID and passes `--session-id <uuid>` on first run, `--resume <uuid>` afterwards. |
| `codex` | `codex` | First run is `codex exec --json …`; resume is `codex exec resume <id> …`. Session id parsed from the first JSONL frame's `payload.id`. |
| `opencode` | `opencode` | `opencode run --format json [--session <id>] …`. Session id read from each event's `sessionID` field. |
| `pi` | `pi` (`@mariozechner/pi-coding-agent`) | `pi --mode json [--session <id>] …`. Session id read from line-1's `id` field. |
| `custom` | (operator-defined) | No resume. Free-form `command + args` from the agents row, exactly like before. |

Pick the kind in the agents view (`/agents`). For named kinds, set the relevant provider key on the agent's env (e.g. `ANTHROPIC_API_KEY` for claude, `OPENAI_API_KEY` for codex, `KIMI_API_KEY` / `MINIMAX_CN_API_KEY` etc. for pi). The "Extra args" field is appended to the adapter's base args — that's where you put `--provider X --model Y` for pi, model overrides, etc.

## PR review → fix loop

Built-in flow `pr-review-fix` triggers when a reviewer submits a review on a PR opened by `issue-implement`. It clones the PR's head branch in place into a fresh worktree, then dispatches the agent — pinned to the **same device** that ran the original implementation, **resuming the same conversation** via the per-kind adapter. The agent applies the feedback and pushes commits to the same branch; if the reviewer comes back, the cycle repeats.

How the device pin works: every `git.create_worktree` upserts a row in `worktree_pins(owner_repo, branch)` carrying the host that ran it. Subsequent flow runs for the same branch look up that row and dispatch to the same host. If the pinned host is offline at trigger time, the engine falls back to `pickIdle()` and the agent starts a fresh conversation (no session id is reachable on a different device).

The review-fix flow only fires on `commented` and `changes_requested` review states by default — `approved` reviews skip it (no fix needed). Adjust in the trigger node config.

**No iteration cap:** GitHub's review/push cycle is the bound. If the operator needs to stop a runaway loop, disable the flow.
