# Lessons Learned — opencara / openkira

Project-specific gotchas and conventions discovered empirically. Cross-project lessons live in `~/.claude/lessons.md`.

## Database & state

### [hits: 1] DB is Postgres (Supabase), DATABASE_URL in packages/orchestrator/.env
- Not SQLite. Connection string lives in `packages/orchestrator/.env` → `DATABASE_URL`.
- Quick query pattern: `set -a && . packages/orchestrator/.env && set +a && psql "$DATABASE_URL" -c "..."`.
- Useful tables: `flow_runs`, `flow_run_steps`, `agent_runs`, `agent_run_logs`, `agent_hosts`, `worktree_pins`, `flows` (config in `graph_json` jsonb), `flow_node_settings` (per-node agent/prompt/host bindings), `sessions` (auth cookies).

### [hits: 1] agent_runs.host_id is NULL on disk
- The orchestrator doesn't persist which device handled an agent_run — the column exists but isn't written.
- To trace routing of a specific failure: check the current orchestrator log around the `started_at` timestamp for `[device-ws] hello / connected / disconnected` lines, or `worktree_pins` (gets set on successful worktree-allocate).

### [hits: 1] Orchestrator log: /tmp/opencara-orchestrator.log (NOT /tmp/orchestrator.log)
- Current orchestrator (`node --import tsx --env-file=.env src/index.ts`) redirects stdout+stderr to `/tmp/opencara-orchestrator.log`.
- `/tmp/orchestrator.log` is from a prior run and stale (mtime weeks old). Don't trust lines from there as current state.
- Definitive lookup: `ls -l /proc/$(pgrep -f 'src/index.ts')/fd/{1,2}`.

### [hits: 1] agent_hosts.version is last-hello, not live
- The `version` column gets bumped each time a device sends `hello` on WS connect. Between reconnects it's stale and may reflect an older incarnation.
- For live state, tail the orchestrator log for the *most recent* `hello from <name>: version=...` line. If the most recent event is `disconnected`, the device isn't currently dispatchable.

### [hits: 1] postgres-js opens a dedicated LISTEN connection NOT counted in pool `max` — keep `max` under the Supabase pooler ceiling
- The orchestrator crashed opencara.com on 2026-06-07 with `PostgresError (EMAXCONNSESSION): max clients reached in session mode - pool_size: 15`. Root cause: the Supabase session pooler (Supavisor) caps this role at **15** concurrent connections, but postgres-js opens a **separate dedicated LISTEN connection** (singleton `listen.sql` with `max:1`, in `node_modules/postgres/src/index.js`) for ALL `pg.listen` channels, on top of the query pool's `max`. With `DB_POOL_MAX=15`, peak was 15 + 1 = 16 > 15 → the pooler rejected the surplus the instant the query pool saturated. Fixed by lowering the default to `12` (`packages/orchestrator/src/db/client.ts`); leaves room for the listen connection + `max_lifetime` recycle overlap.
- The LISTEN connection is a single shared singleton — `pg.listen('a')` and `pg.listen('b')` and 100 concurrent SSE subscribers all multiplex onto ONE connection (extra listeners just push to an in-memory array; only the first per channel sends `LISTEN`). So there is NO per-SSE-stream connection leak — the bug was static over-subscription by one, not a leak. Don't go hunting for un-unlistened subscriptions.
- The crash was delivered by an **unguarded `async setInterval`** in the SSE routes (`runs.ts` / `flows.ts` `terminalCheck`): a rejected DB query inside it is an unhandled rejection, which Node promotes to a fatal `uncaughtException`. Any `setInterval(async …)` that awaits the DB MUST try/catch its whole body. There is now also a process-level `unhandledRejection`/`uncaughtException` backstop in `index.ts` (non-fatal log) because prod runs under bare `nohup` with no supervisor — a crash stays down until a human restarts it.

## Dispatch

### [hits: 1] pickIdle() ignores device capability/version
- `WebSocketDispatcher.pickIdle()` (`packages/orchestrator/src/dispatch/devices.ts:108`) picks any idle/least-loaded device with no capability filter.
- Unpinned `opencara internal …` jobs (worktree create/write-session/remove) can land on devices missing the v0.105.2 fast-path → rejected with `legacy stdin-JSON dispatch removed in v0.30 — orchestrator must send spec.acp`.
- Workaround for a single flow: set `node.config.worktree.hostId` in `graph_json` to a known-current device's id. Long-term fix: filter `pickIdle` by advertised `capabilities`.

### [hits: 1] Trigger env vars: PR flows vs issue flows are disjoint
- `github.pull_request` triggers inject: `OPENCARA_REPO`, `OPENCARA_PR_NUMBER`, `OPENCARA_PR_HEAD_SHA`, `OPENCARA_PR_BASE_SHA`, `OPENCARA_PR_HEAD_REF`, `OPENCARA_AGENT_RUN_ID`. **Not** `OPENCARA_ISSUE_NUMBER`.
- Issue triggers inject `OPENCARA_ISSUE_NUMBER`. The two sets don't overlap.
- A flow cloned from an issue-implement template into a PR context will fail at template-var expansion (`{{OPENCARA_ISSUE_NUMBER}} not in run env`). Update `branchName` / `--from-branch` template vars to a PR-trigger one (e.g. `opencara/pr-{{OPENCARA_PR_NUMBER}}`).

## Releases

### [hits: 1] CLI publish is tag-driven; package.json stays at 0.0.0
- Trigger: pushing a tag matching `v*.*.*` (literally `vX.Y.Z`, NOT `cli-v*`) → `.github/workflows/publish-cli.yml` runs.
- `packages/cli/package.json` `"version": "0.0.0"` is intentional. CI runs `npm version <from-tag> --no-git-tag-version --allow-same-version` before build so esbuild's `define` bakes the real version into `dist/bin.js`. Bumping the file on main is unnecessary (and would just get clobbered next release).
- One-line release for a fix already on main: `git tag -a vX.Y.Z -m "..." <sha> && git push origin vX.Y.Z`.

### [hits: 1] Devices on this box live in npx cache 35cf602f65bb4257
- Cache path: `~/.npm/_npx/35cf602f65bb4257/node_modules/opencara/dist/bin.js`.
- After publish, force a refresh: `rm -rf ~/.npm/_npx/35cf602f65bb4257 && npm exec opencara@latest`. The cache won't re-download otherwise (see user-wide lesson on `npm exec @latest` caching).

## ACP runner

### [hits: 1] `agent_thought_chunk` is a token-level delta, not a whole-thought event
- ACP shims stream reasoning as model-token deltas — opencode's adapter literally calls `sessionUpdate({ content: { text: props.delta } })` per delta (`sst/opencode` → `packages/opencode/src/acp/agent.ts`). Codex emits coarser, message-sized thought events, which is why per-chunk prefixing went unnoticed until opencode landed.
- Don't prefix per chunk in `translateUpdate`-style code; the device concatenates chunks into a stream buffer and you get `[think] I[think]  need[think]  to…` ("opencode replies with a lot of [think]" symptom).
- Pattern: stateful translator that fences boundaries (`createUpdateTranslator` in `packages/cli/src/runner/acpRunner.ts`) — `\n[think]\n` on entering a thought run, `\n[/think]\n` on leaving (or on `flush()` at run end so cancel/error paths still close cleanly).

## API access

### [hits: 1] Session cookie name is ocara_sid
- Source: `packages/orchestrator/.env` → `SESSION_COOKIE_NAME=ocara_sid`.
- For curling protected endpoints locally: `psql "$DATABASE_URL" -At -c "SELECT id FROM sessions WHERE expires_at > now() ORDER BY expires_at DESC LIMIT 1;"` → use as `Cookie: ocara_sid=<id>`.

### [hits: 1] Flow rerun API preserves upstream success
- `POST /api/flow-runs/:id/rerun` with body `{"fromStepId":"<failed-step-id>"}`: preloads outputs from upstream succeeded steps and only re-executes from that step onward. Omit `fromStepId` to re-run from the trigger.
- Saves agent costs when an upstream reviewer ran for minutes successfully and a later step failed.
- Look up the step id: `SELECT id FROM flow_run_steps WHERE flow_run_id='<old-run-id>' AND node_id='<node>';`.

## Architecture quirks

### [hits: 1] Worktree allocation runs as its own agent_run, unpinned
- `nodeRunners.ts:517-539` dispatches `opencara internal worktree create` as a SEPARATE `agent_run` from the node's actual agent. Its `pinnedHostId` reads only `node.config.worktree.hostId`, NOT the agent's pin from `flow_node_settings`.
- Consequence: a flow node whose agent is pinned to host X can still allocate its worktree on host Y (because of `pickIdle`), and then the orchestrator pins the agent to Y too (via `allocateResult.agentHostId` at line 593). The agent doesn't run where you expected.
- To force a node to use one host end-to-end: set both the agent's hostId AND the node's `worktree.hostId`.

### [hits: 1] Persistent worktree dir on the device under ~/.opencara/work/
- Layout: `~/.opencara/work/<owner>/<repo>/branch-<safe>/checkout/`. Sessions: `~/.opencara/sessions/<key>/`.
- The same dir is reused across runs on the same (repo, branch, key). The "first run" clones; subsequent runs `git fetch` + checkout. Branches created locally by an agent persist there.
- When inspecting a device-side failure related to a specific PR, this is the dir to check (`git branch`, `git status`, `git log --all`).
