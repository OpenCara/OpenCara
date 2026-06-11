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

### [hits: 1] Drizzle migrations need BOTH the .sql file AND a `_journal.json` entry
- `drizzle-kit migrate` (and the postgres-js migrator at runtime) reads `drizzle/meta/_journal.json` and only applies `.sql` files whose `tag` appears there. A migration committed as just a `.sql` file is silently skipped on deploy.
- This is how PR #88 broke prod: it shipped `drizzle/0028_project_default_implement_flow.sql` without a journal entry, schema.ts already selected the new column, and every read of `projects` 500'd with `column "default_implement_flow_id" does not exist` — surfaced in the UI as "Project not found." on every project.
- When adding a migration by hand, also append `{ idx, version: "7", when, tag, breakpoints: true }` to `packages/orchestrator/drizzle/meta/_journal.json`. `when` increments by 10_000_000_000 in this repo's history.
- Recovery if it already shipped: apply the SQL manually, then `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (sha256(file), <when>);` so a later `drizzle-kit migrate` (after the journal is fixed in the repo) treats it as already-applied. The hash drizzle uses is `sha256sum` of the raw .sql file contents.

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

## Deploy / restart

### [hits: 1] Prod provider keys must live in packages/orchestrator/.env, NOT only the launching shell
- Prod runs as `node --import tsx --env-file=.env src/index.ts` (cwd `packages/orchestrator`, log `/tmp/opencara-orchestrator.log`, port 3030). `--env-file=.env` is the ONLY env source on a clean restart.
- Gotcha (2026-06-11): the model-provider keys (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GEMINI_API_KEY_AUTH_MECHANISM`, `KIMI_API_KEY`, `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY`) were present in the *running process* but were NEVER in `.env` — they'd been exported in the shell that first launched it. A plain `--env-file=.env` restart silently drops them. They're now appended to `.env` (gitignored, confirmed via `git check-ignore`), so restarts are reproducible. Before killing prod, diff live env vs `.env` and persist anything provider/secret-shaped that's only in the live process.
- `/proc/$PID/environ` shows ONLY exec-time vars, never what Node's `--env-file` injects at runtime — so DATABASE_URL/PORT/etc. always look "missing" there even though the app has them. To verify what the app actually sees, run `node --import tsx --env-file=.env -e 'console.log(process.env.KIMI_API_KEY?.length)'`, don't grep `/proc/environ`.
- Don't try to clone the old env with `xargs -0 env node ...` — it split the 98-var environ into batches and only the first applied (lost KIMI_API_KEY + MINIMAX_CN_API_KEY), AND `env -i $(...)` word-splits values and dies (`env: '53213': No such file or directory`). Fix the source of truth (`.env`) and restart with `--env-file` alone.
- Detached relaunch that survives the shell: `setsid bash -c 'exec /usr/bin/node --import tsx --env-file=.env src/index.ts' >> /tmp/opencara-orchestrator.log 2>&1 < /dev/null &`.

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

### [hits: 1] "Project not found." with NO /login redirect = session bound to a non-owner user (relogin fixes it)
- Symptom: an existing project page (`/projects/<id>`) renders "Project not found." in the browser, but the app did NOT bounce to `/login`. Fixed instantly by logging out + back in (2026-06-10, OpenCara/OpenCara project page).
- Mechanism: project reads gate on ownership — `GET /api/projects/:id` → `loadOwnedProjectWithInstallation(db, id, user.id)` (`packages/orchestrator/src/auth/ownership.ts`) filters `projects.added_by_user_id = session.userId` (inner-joined to the installation). A miss returns 404 (never 403, by design), and the UI renders ANY non-200 from `projectQuery` as "Project not found." (`ProjectDetailPage.tsx`: `if (!project.data)`). Because `AuthGate`'s `me` query still succeeded (200), the session is valid — just owned by a *different* user than the project. So you stay on the page instead of being redirected.
- This is a DIFFERENT cause than the migration-500 case above (missing column → 500 → same "Project not found." string). Distinguish by curling the API: 404/401 = ownership/session; 500 = server/schema. Reproduce ownership server-side: `psql ... -c "select 1 from projects p join github_installations i on p.installation_id=i.id where p.id='<pid>' and p.added_by_user_id='<uid>'"` — if it returns a row for the owner but the browser still 404s, the browser session belongs to someone else.
- There are now multiple users on prod (e.g. `talespark-git`, `eudaup`, `King1725an208` alongside `quabug`). Easy to be logged into the wrong one after they sign in on the same browser. CHECK THE ACTIVE SESSION'S USER before assuming data loss: `select s.user_id, u.github_login from sessions s join users u on u.id=s.user_id where s.expires_at>now() order by s.expires_at desc;`.

### [hits: 1] Flow rerun API preserves upstream success
- `POST /api/flow-runs/:id/rerun` with body `{"fromStepId":"<failed-step-id>"}`: preloads outputs from upstream succeeded steps and only re-executes from that step onward. Omit `fromStepId` to re-run from the trigger.
- Saves agent costs when an upstream reviewer ran for minutes successfully and a later step failed.
- Look up the step id: `SELECT id FROM flow_run_steps WHERE flow_run_id='<old-run-id>' AND node_id='<node>';`.

## Webhooks

### [hits: 1] Duplicate reviews/runs come from GitHub at-least-once delivery, NOT a double webhook config
- Symptom: one fix push → two `pr-review` runs → two PR reviews seconds apart (e.g. PR #144, 2026-06-02).
- Root cause, in order: (1) the webhook endpoint at `opencara.quabug.de` is **timing out** — GitHub's App delivery log (`GET /app/hook/deliveries` with an App JWT from `opencara.private-key.pem`) showed every delivery `status=timed out, dur=10`. (2) A chronically slow endpoint makes GitHub **re-emit deliveries as fresh originals** (`redelivery=False`, distinct `x-github-delivery` GUIDs, identical `before`/`after` SHA). (3) `webhooks.ts` dedups only on the delivery GUID (`platform_events.id = x-github-delivery` + `.onConflictDoNothing()`), so two GUIDs for the same push = two `platform_events` rows = two `dispatchEvent` → two reviews.
- It is NOT caused by two webhook configs or two Apps: confirmed via `gh api repos/.../hooks` (none), `gh api orgs/OpenCara/hooks` (only a `projects_v2_item` kanban hook), and `platform_events.installation_id` on the dup events (both = prod App install `120583623`; `opencara-dev` install `117464084` was not the source). Don't go hunting for a duplicate subscription to delete — there isn't one.
- Two fixes, both needed: (a) **ack fast** — `return c.json({ok:true})` before the awaited DB work / move insert+dispatch off the response path, so GitHub stops timing out (the in-process flow dispatcher saturating the event loop is the likely staller). (b) **content-level idempotency** — dedup `pr-review` on `(projectId, eventType, action, after-SHA)` or skip if a review already exists for the PR's current head SHA; GUID-only dedup can't stop GitHub's legal duplicate originals.
- To inspect the App delivery log: mint an RS256 JWT (`iss`=GITHUB_APP_ID 3113278, `exp`<10min) signed with `packages/orchestrator/opencara.private-key.pem`, then `curl -H "Authorization: Bearer $JWT" https://api.github.com/app/hook/deliveries?per_page=100`.

## Architecture quirks

### [hits: 1] Worktree allocation runs as its own agent_run, unpinned
- `nodeRunners.ts:517-539` dispatches `opencara internal worktree create` as a SEPARATE `agent_run` from the node's actual agent. Its `pinnedHostId` reads only `node.config.worktree.hostId`, NOT the agent's pin from `flow_node_settings`.
- Consequence: a flow node whose agent is pinned to host X can still allocate its worktree on host Y (because of `pickIdle`), and then the orchestrator pins the agent to Y too (via `allocateResult.agentHostId` at line 593). The agent doesn't run where you expected.
- To force a node to use one host end-to-end: set both the agent's hostId AND the node's `worktree.hostId`.

### [hits: 1] Persistent worktree dir on the device under ~/.opencara/work/
- Layout: `~/.opencara/work/<owner>/<repo>/branch-<safe>/checkout/`. Sessions: `~/.opencara/sessions/<key>/`.
- The same dir is reused across runs on the same (repo, branch, key). The "first run" clones; subsequent runs `git fetch` + checkout. Branches created locally by an agent persist there.
- When inspecting a device-side failure related to a specific PR, this is the dir to check (`git branch`, `git status`, `git log --all`).

### [hits: 2] template_drafts shadow the code template in the flow seeder — editing a built-in's code graph won't propagate
- `ensureBuiltinFlowsForProject` → `resolveSeedGraph` (`packages/orchestrator/src/flows/builtin.ts`) prefers an owner's `template_drafts` row (keyed by `userId` + `templateSlug`) over the code-defined `builtinFlows` graph. So if a built-in flow's code template changes (e.g. adding the multi-review fan-out to `development-lifecycle`), every project whose owner has a saved draft keeps re-seeding the OLD graph — even with `flows.customized_at` NULL (false). Symptom: the new nodes never appear in the live flow despite a clean deploy + reseed.
- Drafts can be stale auto-snapshots of a prior default, not intentional customizations — they then permanently pin projects to the old graph as the code template evolves.
- Fix: delete the stale draft (scope it so you only drop pre-change drafts, e.g. `WHERE NOT (graph_json->'nodes') @> '[{"id":"<new-node-id>"}]'::jsonb`); the boot-time `seedBuiltinFlowsForAllProjects` (runs after `migrate()` in `index.ts`) then refreshes non-customized project flows from the code template. Per-node agent/prompt assignments live in `template_node_settings` (keyed independently of the draft) and survive the delete. Migration 0035 did exactly this for `development-lifecycle`.
- Renaming a flow slug must also rename `flows.slug` + `template_drafts.template_slug` + `template_node_settings.template_slug` in lockstep (migration 0034), or the seeder treats the new slug as a brand-new built-in and INSERTs a duplicate row → double-dispatch.
- RECURS: a fresh draft is created the moment the owner edits the **template** page (`/flows/<slug>` template detail, not a project flow) — any node-config/add/remove on template scope writes a `template_drafts` row snapshotting the then-current graph. After that, every subsequent code-template deploy is silently ignored for that owner's projects (they reseed from the frozen draft) even though `customized_at` stays NULL. Verified twice on `development-lifecycle` (2026-06-04 migration 0035, then again 2026-06-05). Quick live fix (no migration): `DELETE FROM template_drafts WHERE template_slug='development-lifecycle'` then run `seedBuiltinFlowsForAllProjects(db)` in a one-off `node --import tsx --env-file=.env` script — the orchestrator serves flows from the DB per request, so no restart needed. When a deploy's graph/position/config changes don't show up live, CHECK FOR A DRAFT FIRST (`select count(*) from template_drafts where template_slug=...`).
