# OpenCara

Orchestration layer between AI agents and GitHub (extensible to other platforms).

OpenCara receives webhook events from GitHub, coordinates agents driven by those events, and writes results back to the platform.

The full development lifecycle ships as four built-in flows — `issue-implement`, `pr-review-multi`, `pr-review`, `pr-review-fix` — one trigger each, chained by platform round-trips:

- Issue moves from `backlog` → `ready` on a GitHub Projects v2 board → dispatch the implement agent (it commits, pushes, and opens the PR).
- PR opened → run the reviewer agent pool (an ordered list of agents sharing one prompt, N in parallel with failover) → synthesize the successful reviews into one → post it; follow-up pushes get a lighter single-reviewer pass.
- Review submitted (or an `@opencara fix` comment) → wake the implement agent in the same worktree to address feedback, then optionally auto-merge.

Each flow has exactly one trigger, and the engine pre-filters every incoming webhook per flow (trigger kind, PR action, comment phrase), so an event reaches only the stage that can take it — no `trigger_skip` noise on the other three. Reviews of one PR are serialised (one running, the newest request queued), a configurable grace period lets a quick merge or an ignored label cancel a review before it starts, and a merge / ignored label during a review cancels it, agents included.

## Using opencara.com

### Why

[opencara.com](https://opencara.com) is the hosted orchestrator. It turns the lifecycle above on for your own repos without running any server yourself — you bring the machines the agents run on:

- **Your hardware, your keys.** Agents execute on devices you pair (a laptop, a homelab box, a VPS), using your own provider subscriptions and API keys. Nothing about your code or credentials passes through a third-party runner; opencara.com only sees webhook events, orchestration state, and the logs the device streams back.
- **No CI minutes, real dev environments.** Agents run where your toolchain already works — with your installed CLIs, caches, and checkouts. Worktrees persist per PR branch, so a fix iteration resumes the same conversation in the same checkout instead of starting cold.
- **The full loop, not one bot.** Issue → implementation PR → multi-agent review → review-driven fixes → optional auto-merge, visible end-to-end as flow runs you can inspect, edit, and re-run per project.

### How

1. **Sign in** at [opencara.com](https://opencara.com) with your GitHub account.
2. **Install the GitHub App** on the repos you want automated: [github.com/apps/opencara](https://github.com/apps/opencara/installations/new). The permissions it asks for are listed [below](#github-app-permissions-and-events).
3. **Add a project** (`/projects` → add): pick the installation and repo. The four built-in stage flows are seeded automatically.
4. **Pair a device** — on the machine that should run agents:

   ```bash
   npx opencara        # or: npm i -g opencara && opencara
   ```

   First start prints a pairing code and opens `/devices/pair` in your browser; confirm there, and the daemon stays connected waiting for jobs. Keep it running (tmux, systemd, …). Pair as many devices as you like.
5. **Create an agent** (`/agents`): pick a kind (`claude`, `codex`, `opencode`, `pi`, `omp`, or `cursor` — see [Agent kinds](#agent-kinds-acp)) and set the provider API key in the agent's env. The device must have the underlying tool available (e.g. the `claude` CLI for kind `claude`; the `npx`-based adapters fetch themselves).
6. **Bind agents to the flow**: open the project's flow and click a node — pick a prompt (optional) and add your agents in priority order. The first agent is the node's primary; the rest are fallbacks. On the reviewer node, set "Run in parallel" to the number of reviews you want per PR.
7. **Use it from GitHub**: move an issue to `Ready` on the linked Projects v2 board to get an implementation PR; open a PR to get a synthesized multi-agent review; submit a review or comment `@opencara fix` to send the agent back for fixes. Watch progress live on the project's flow-run pages.

Self-hosting the orchestrator instead is just this repo + Postgres + your own GitHub App — see [Development](#development) and [Deployment](#deployment).

## Architecture

| Package | Purpose |
| --- | --- |
| `packages/shared` | Shared TS types and wire-protocol contracts. Published to npm as `@opencara/shared`. |
| `packages/flows` | Built-in flow definitions + Zod schemas for the orchestrator's DAG types. |
| `packages/orchestrator` | Hono server: webhook ingestion, event-driven agent dispatch, persistent state (Postgres + Drizzle). |
| `packages/cli` | Agent-host CLI. Daemon that registers a machine with the orchestrator and runs dispatched agents as [ACP](https://agentclientprotocol.com) subprocesses. Published as [`opencara`](https://www.npmjs.com/package/opencara) (`npm i -g opencara` → `opencara`, `opencara-mcp`, and `claude-acp` binaries; runs the pair flow on first start, then accepts jobs). Think: GitHub Actions self-hosted runners. |
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

## Deployment

Pushing a `v<semver>` tag builds a versioned Docker image, pushes it to GHCR, rolls it out to opencara.com over SSH (gated on a health check), and publishes the `opencara` CLI to npm at the same version. Rollback is redeploying a prior image tag — no rebuild. See [`deploy/README.md`](deploy/README.md) for secrets, host setup, and the rollback procedure. (`packages/cli/package.json` stays at `0.0.0` on purpose; CI stamps the version from the tag before publishing.)

```bash
git tag v1.0.2 && git push origin v1.0.2
```

## GitHub App permissions and events

For the built-in flows to work end-to-end, the GitHub App needs:

- **Repository permissions:** `Issues: read & write`, `Pull requests: read & write`, `Metadata: read`, `Contents: read & write`, `Checks: read`.
- **Organization permissions:** `Projects: read` (required to receive the `projects_v2_item` events that drive the implement stage).
- **Subscribed events:** `Pull request`, `Issues`, `Projects v2 item`, `Installation`, `Installation repositories`.

The `Issues` and `Projects v2 item` subscriptions drive the Issues tab on the project page (issue rows are normalized from the webhook + a one-shot REST backfill on project add) and the implement trigger (Projects v2 status changes).

## Azure DevOps

Azure DevOps Services (`dev.azure.com`) is supported alongside GitHub. Azure DevOps Server (on-prem) is not.

> ### Which credential can reach your organization
>
> Azure DevOps registers itself in Microsoft Entra with `signInAudience = AzureADMultipleOrgs` — **work/school accounts only**. An organization backed by a *personal* Microsoft account (the default when one is created under an @outlook/@msn address and never connected to a directory) can therefore **never** be reached by Entra OAuth, no matter how the app registration is configured. Signing in with a personal account fails with "You can't sign in here with a personal account."
>
> | Your organization | Use |
> |---|---|
> | Backed by an Entra directory | **Microsoft sign-in** (Settings → Link), or a PAT |
> | Backed by a personal Microsoft account | **Personal Access Token** — the only option |
>
> A PAT connection needs no Entra app at all; `AZDO_ENTRA_*` can be left unset entirely.

**Status.** Sign in with Microsoft, connect an organization, add repositories as projects, and PR flows run end-to-end: a pull request event dispatches the flow, the agent gets a worktree and a token, and reviews post back as a comment thread plus a reviewer vote.

Not yet done: **Boards/kanban mirroring** (work item events are received and recorded but drive no board), **auto-merge**, **PR↔work-item linking**, and **draft-PR ready-for-review** — each is skipped with a log line on Azure DevOps rather than failing the run. Diffs are not inlined into the agent's stdin (see below). See ROADMAP.md.

> **The `pr-review-fix` flow does not run on Azure DevOps.**
> That stage is keyed on a `scm.pull_request_review` trigger, and nothing in the Azure DevOps path ever produces one: service hooks have no reviewer-vote event, and `git.pullrequest.updated` — which does fire on a vote — says nothing about what changed, so a vote is not distinguishable from any other edit. On an Azure DevOps project the implement and review flows work and the **`pr-review-fix` flow silently never fires**. Reviews still post; nothing consumes them.
>
> A lossy proxy is possible — treat `git.pullrequest.updated` as a review event when any reviewer carries a non-zero vote — but it would re-fire on every later update to the same PR, so it needs deduplication work first. Tracked in ROADMAP.md.

**How a `git.pullrequest.updated` is classified.** Azure DevOps sends that one event for everything — a push, a title edit, a reviewer being added, a vote — so it is resolved in two passes: it maps to `synchronize` (the action that re-runs a review), then the source commit is compared against the PR's previous delivery. An unchanged commit means the branch did not move, and the event is demoted to `edited`, which no trigger selects. Without that second pass every PR was reviewed twice — Azure fires an `updated` seconds after `created` merely because the author is auto-added as a reviewer, and that lit the single-review stage while the multi-reviewer fan-out from `created` was still running. The comparison **fails open**: when either commit is unknown the event stays a `synchronize`, since a review that never runs is worse than one extra.

A deployment can be Azure-DevOps-only: with `AZDO_ENTRA_*` and `SESSION_ENCRYPTION_KEY` set and no `GITHUB_APP_*`, auth, `/api/*`, `/webhooks/azure-devops` and the flow engine all mount. `/api/installations` and the GitHub sign-in routes are simply absent, and the login page offers Microsoft alone.

### What agents get on Azure DevOps

Run context uses the **same `OPENCARA_*` variable names** as GitHub, so prompts and flow templates are portable. Two additions and one gap:

- `OPENCARA_PLATFORM=azure_devops`, plus `OPENCARA_AZDO_ORG` / `OPENCARA_AZDO_PROJECT` / `OPENCARA_REPO_NAME`.
- The token arrives as `OPENCARA_SCM_TOKEN` and `AZURE_DEVOPS_EXT_PAT` (what `az repos` reads) — **not** as `GH_TOKEN`, so `gh` cannot pick up an Azure DevOps token and fail confusingly against github.com.
- `OPENCARA_PR_DIFF_INLINE=0` and an empty `stdin.diff`. Azure DevOps has no single endpoint returning a unified diff for a PR, so rather than inline a partial one, agents are expected to `git diff` in the worktree. Reviewer flows without a worktree will see no diff.

### Setup

1. Register a **Microsoft Entra ID** application (portal.azure.com → Microsoft Entra ID → App registrations).
   Entra rather than an Azure DevOps OAuth app: Microsoft stopped accepting new Azure DevOps OAuth registrations in April 2025 and is retiring that service.
2. Add the redirect URI `<PUBLIC_BASE_URL>/auth/azure/callback`.
3. Grant the app **Azure DevOps** delegated permissions. Four are needed, and all four are load-bearing:

   | Scope | Why |
   |---|---|
   | `vso.code_write` | Repos, pull requests, PR comment threads, reviewer votes, labels |
   | `vso.work_write` | Work items |
   | `vso.notification_write` | **Service hook subscriptions.** Adding a repo creates them; without this, adding a project fails |
   | `vso.profile` | The profile/accounts lookup that lists which organizations you can connect |

   Note `vso.threads_full` does **not** exist as an Entra delegated scope — that name comes from Azure DevOps' separate PAT scope vocabulary. PR threads are covered by `vso.code_write`.
4. Grant admin consent (`az ad app permission admin-consent --id <appId>`, or the portal button) so users aren't prompted individually.
5. Set `AZDO_ENTRA_CLIENT_ID`, `AZDO_ENTRA_CLIENT_SECRET`, and optionally `AZDO_ENTRA_TENANT` (`common` by default; pin your tenant GUID for a single-tenant deployment).
6. Restart. The login page grows a "Sign in with Microsoft" button and **Add project** grows an Azure DevOps tab.

`PUBLIC_BASE_URL` **must be HTTPS.** Azure DevOps refuses to create a service hook subscription with basic-auth credentials against a plaintext endpoint, so every subscription will fail on an `http://` deployment.

### Connecting with a Personal Access Token

For an organization Entra cannot reach (see the box above), or simply to avoid registering an Entra app:

1. In Azure DevOps: **User settings → Personal access tokens → New Token**, scoped to your organization.
2. Grant **Code (read & write)**, **Work items (read & write)**, and **Service hooks (read & write)**. The last is what lets adding a repository create its subscriptions.
3. In OpenCara: **Add project → Azure DevOps → Connect with an access token**, enter the organization name (the segment after `dev.azure.com/`) and the token.

The token is verified against the organization before it is stored, so a wrong, expired, or mis-scoped token is reported immediately rather than failing on first use. It is encrypted with `SESSION_ENCRYPTION_KEY`, like every other stored credential. Re-entering a token for an organization you already connected rotates it in place.

Trade-off worth knowing: a PAT is a static secret with no refresh and whatever scopes you granted it. Unlike the Entra path there is no per-run token, so the credential handed to an agent is the PAT itself for as long as it is valid. Scope it to the one organization and set an expiry.

### Linking Azure DevOps to an existing account

One OpenCara account can hold several sign-in identities (`user_identities`), so the normal flow is:

1. Sign in with **GitHub** as usual — that stays your OpenCara account.
2. **Settings → Linked accounts → Azure DevOps → Link.** This runs the Microsoft OAuth flow in *link* mode: it attaches the Entra identity to the account you are already signed in as, and stores the Microsoft tokens on your current session. No second account, no second session.
3. **Add project → Azure DevOps** now works, and the organizations and repos you add belong to the same account as your GitHub projects.

`/auth/azure/login` (the login-page button) still creates an account when nobody is signed in — that is what makes an Azure-DevOps-only deployment usable. The mode is decided by which state cookie the callback matches, never by a query parameter, so a caller cannot ask for link mode.

**Linking refuses if that Microsoft identity is already attached to a different OpenCara account.** Silently re-pointing an identity would mean whoever controls the Microsoft account inherits whichever OpenCara account linked it last; unlink from the other account first.

**Unlinking** refuses while you still have Azure DevOps connections — removing a connection cascade-deletes its projects, which is too destructive to hide behind an "unlink" button. Remove the Azure projects first. You also cannot unlink your only identity, since nothing would be left to sign in with.

### Credentials: how this differs from the GitHub App

This is the part worth understanding before you connect a production organization.

A GitHub App installation token is scoped to specific repositories, acts as a distinct bot identity, and is revoked the moment an agent run finishes. An Entra token is **user-delegated**, and none of those three things hold:

- **No repository scoping.** The token carries whatever Azure DevOps permissions the app registration was granted, across every organization the connecting user can reach. An agent handed that token can reach all of it. Narrow the app registration — that is the only place this can be constrained.
- **No revocation.** Access tokens simply expire (~1h). There is no equivalent of GitHub's token-revoke call, so a leaked token is valid until it ages out.
- **No bot identity.** PR comments and reviewer votes are attributed to the person who connected the organization, not to `opencara[bot]`. Automated review→fix loops that filter on a bot login need to filter on that user instead.

A note on votes, since branch policies key off them: every review writes a vote, including the explicit **0** for a commented review. That is what clears a previous verdict — without it, an approve followed later by a comment-only review would leave "Approved" standing, and a required-reviewer policy could honour that stale approval to merge a PR whose latest review raised a concern. OpenCara therefore appears as a reviewer on any PR it reviews, even when it is only commenting.

Refresh tokens are stored encrypted with `SESSION_ENCRYPTION_KEY`, the same cipher as GitHub session tokens, and agents are only ever handed a short-lived access token — never the refresh token.

### Webhooks

Azure DevOps does not sign webhook deliveries. Where the GitHub handler verifies an HMAC over the body, service hooks authenticate with **HTTP Basic**, and the password registered on the subscription is the entire inbound authentication. OpenCara generates a random 32-byte secret per connection, stores it encrypted, and compares it in constant time. Treat it like `GITHUB_WEBHOOK_SECRET`: anyone holding it can drive agent runs.

Adding a repository creates one subscription per event type (`git.pullrequest.created`, `git.pullrequest.updated`, the PR comment event, `workitem.created`, `workitem.updated`) scoped to that repository. Removing the project deletes them by the ids recorded on the project row.

That teardown is **best-effort**: subscriptions live in your Azure DevOps organization, not in OpenCara's database, so a revoked grant or an API outage can leave them behind. Nothing retries, and an orphaned subscription is effectively permanent — the handler answers 200 for an unmatched repo (see above), so Azure never auto-disables it. Removal logs the subscription ids at `error` level when it can't delete them; those need clearing by hand from the Azure DevOps project's **Service Hooks** page.

Azure DevOps **auto-disables a subscription** after repeated delivery failures, silently. The webhook handler therefore answers 200 even for payloads it cannot map, so an unrecognised event variant can never tear down a working hook.

## Agent runtime credentials

Each agent run dispatched through a flow gets an ephemeral GitHub App installation token injected into its environment, so `gh` and any octokit-based tool work out of the box without per-host `gh auth login`:

- `GH_TOKEN`, `GITHUB_TOKEN` — same value, ≤1h TTL, scoped to the project's repo with `contents: write, issues: write, pull_requests: write, checks: read` (`contents: write` is needed for the implement stage to push branches; `checks: read` lets agents query Check Run status for auto-merge gating).
- `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` — pinned to `opencara[bot]` so commits attribute to the App and don't leak the host's global `~/.gitconfig` identity into the run.

The token is minted per run and revoked when the agent finishes. Identity inside the agent: `gh api user` returns `apps/<slug>` (the App's bot identity); the persisted `agent_runs.spec.env` shows `<ephemeral>` for the token fields rather than the secret.

Limitations (v1):

- No refresh — runs longer than ~1h hit a 401 on late `gh` calls. Most agent runs finish in minutes.
- The smoke-test endpoint (`POST /api/agents/:id/test`) does not inject a token; test runs already see `OPENCARA_TEST=1`.

## Worktrees + PR creation

Agents that need a checkout configure a worktree directly on the agent flow node — `agent.config.worktree = { fromBranch, hostId, cacheRepo }`. **Every agent attempt gets its own fresh checkout** on a paired device under `~/.opencara/work/<owner>/<repo>/step-<flow_run_step id>/checkout/`, so parallel pool slots never share a working tree. The branch is derived from the trigger, not configured: a PR trigger checks out the PR head ref, an issue trigger creates `opencara/issue-<n>` off `fromBranch` (default: the repo default branch), and schedule / manual runs get `opencara/run-<flow run id>`. The checkout is exposed to the agent via `OPENCARA_WORKTREE_DIR` / `OPENCARA_WORKTREE_BRANCH` / `OPENCARA_SESSION_DIR`. The agent commits, pushes, and (in the implement stage) calls `gh pr create` itself — there is no dedicated `github.create_pull_request` flow node; the agent's injected `GH_TOKEN` is what makes this work. Enable `agent.config.draftPr` to inject `OPENCARA_PR_DRAFT=1`; the agent should pass `--draft` to `gh pr create`, and after a successful agent run the engine marks that branch's open draft PR ready for review.

**Worktrees are not reused across runs.** A review-fix iteration clones the PR head ref afresh; context reaches the agent through the PR/issue conversation and `previousOutput`. Enable `cacheRepo` so each clone borrows objects from one per-repo cache (`git clone --reference`) and only the working-tree files cost disk.

**Cleanup.** The checkout is removed as soon as its attempt finishes (success, failure or cancel) via `opencara internal worktree remove --key <slug>` on the device that holds it, and its `worktree_pins` row is deleted. Leftovers are handled by two sweeps: `pull_request.closed` removes every pin still on that head ref, and a periodic job (5 min after boot, then every 6h) prunes pins older than 1 day and asks every connected device to `opencara internal worktree gc --max-age-hours 24 --keep <live keys…>`, which deletes any checkout or session dir on disk older than a day that the orchestrator has no live pin for — including legacy per-branch checkouts and half-built dirs from a crashed allocation.

CLI side: `opencara internal worktree {create,remove,write-session,gc}`. **Keep paired devices on a current CLI build** — device and orchestrator exchange a host-protocol version in the `hello`/`hello-ack` handshake (`packages/shared/src/host-protocol.ts`), and CLIs predating the ACP cutover can't run dispatched agents at all. `npm exec opencara@latest` on each paired host after upgrading the orchestrator.

## Agent kinds (ACP)

Every agent runs as an [Agent Client Protocol](https://agentclientprotocol.com) subprocess on the paired device — the legacy stdin-JSON runner is gone. `agents.kind` selects which ACP adapter the device spawns (`packages/orchestrator/src/agents/acp-gate.ts`):

| Kind | Adapter command |
|---|---|
| `claude` | `claude-acp` — in-package shim around the local `claude` CLI; ships inside the `opencara` npm package and resolves to the bundled `dist/claude-acp.js`, no separate install. |
| `codex` | `npx --yes @zed-industries/codex-acp` |
| `opencode` | `npx --yes opencode-ai@latest acp` |
| `pi` | `npx --yes pi-acp@latest` |
| `omp` | `npx --yes @oh-my-pi/pi-coding-agent@latest acp` — Oh My Pi's native ACP server. The npm *package* name is not the `omp` bin name; the device also needs `bun` on PATH. Credentials come from the device's `~/.omp/agent/models.yml` (per-provider `apiKey`) or an account added with `/login`, so the agent's env can usually stay empty. |
| `cursor` | `cursor-agent acp` — the Cursor CLI's native ACP server. Install it on the device (`cursor-agent login` once); it is not fetchable via npx. |

(`custom` survives in the Postgres enum for pre-cutover rows but is no longer dispatchable — re-save those agents with a registered kind.)

Pick the kind in the agents view (`/agents`) and set the relevant provider key on the agent's env (e.g. `ANTHROPIC_API_KEY` for claude, `OPENAI_API_KEY` for codex, `KIMI_API_KEY` / `MINIMAX_CN_API_KEY` etc. for pi). Model selection: put `--model <id>` in the agent's args and the orchestrator translates it per adapter (codex takes a `-c model="…"` config override; adapters that advertise a model option — claude-acp, opencode, omp, cursor — get it over ACP `session/set_config_option`). Two kinds have quirky model ids: `omp` wants the provider-qualified form (`volcengine-ark/kimi-k3`, from `omp models`), and `cursor` only accepts the parameterized ids it advertises over ACP (`grok-4.6[effort=high,fast=true]`) — its argv `--model` names are a different namespace, so the orchestrator drops `--model` from cursor's argv and selects the model over ACP alone. The "ACP args" field replaces the adapter's args verbatim when set (for `cursor` a `--model` there is still routed over ACP rather than onto argv, for the namespace reason above); the adapter *command* is always fixed by kind.

**Resume:** the session id an agent ends a run with is persisted (`agent_runs.spec.acp.priorSessionId`, plus `agent-session.json` next to the worktree on the device). The next run on the same (repo, branch) is pinned to the same device and resumes that conversation where the adapter supports it — so a fix iteration wakes up with the implementer's prior context intact.

## PR review → fix loop

The `pr-review-fix` flow triggers when a reviewer submits a review on the PR — `commented` and `changes_requested` states by default; `approved` skips it (adjust in the trigger node config) — or when someone comments `@opencara fix`. It re-dispatches the implement agent pinned to the **same device** that produced the branch, in the same persistent worktree, **resuming the same conversation** via the ACP adapter. The agent applies the feedback and pushes commits to the same branch; if the reviewer comes back, the cycle repeats.

How the device pin works: worktree allocation upserts a row in `worktree_pins(owner_repo, branch)` carrying the host that ran it. Subsequent flow runs for the same branch look up that row and dispatch to the same host. If the pinned host is offline at trigger time, the engine falls back to `pickIdle()` and the agent starts a fresh conversation (no session id is reachable on a different device).

**No iteration cap:** GitHub's review/push cycle is the bound. If the operator needs to stop a runaway loop, disable the flow.

## Scheduled flows

Flows can also fire on a timer instead of a webhook: a `schedule.cron` trigger node carries a cron expression + timezone, and the orchestrator's scheduler (`packages/orchestrator/src/flows/scheduler.ts`) persists the next fire time per `(flow, node)` and dispatches when it comes due. Useful for periodic maintenance tasks (dependency bumps, triage sweeps) on a project without any GitHub event involved.
