# Lessons Learned — opencara / openkira

Project-specific gotchas and conventions discovered empirically. Cross-project lessons live in `~/.claude/lessons.md`.

## Database & state

### [hits: 1] DB is Postgres (Supabase), DATABASE_URL in packages/orchestrator/.env
- Not SQLite. Connection string lives in `packages/orchestrator/.env` → `DATABASE_URL`.
- Quick query pattern: `set -a && . packages/orchestrator/.env && set +a && psql "$DATABASE_URL" -c "..."`.
- Useful tables: `flow_runs`, `flow_run_steps`, `agent_runs`, `agent_run_logs`, `agent_hosts`, `worktree_pins`, `flows` (config in `graph_json` jsonb), `flow_node_settings` (per-node agent/prompt/host bindings), `sessions` (auth cookies).

### [hits: 1] Adding a pg enum value: drizzle runs ALL pending migrations in ONE transaction, and a fresh-DB test gives a FALSE PASS
- `ALTER TYPE x ADD VALUE 'v'` followed by any use of `'v'` fails with `ERROR: unsafe use of new value "v" of enum type x` — Postgres won't let a new enum value be used in the transaction that added it.
- Splitting the ADD VALUE into its own migration FILE does NOT fix it. The postgres-js migrator wraps every pending migration in a single transaction, so on the deploy where both are pending they share one. (This is what I assumed would work when adding `azure_devops` to `platform` on 2026-08-11; it doesn't.)
- **The dangerous part**: it does NOT reproduce against a fresh database. Postgres exempts the case where the enum type was CREATED in the same transaction — exactly what a from-scratch `0000..NNNN` replay does. So `migrate()` on an empty DB says OK while the prod upgrade dies. Verified both directions against `postgres:17-alpine`.
- Fixes, in order of preference: (a) don't reference the literal — compare `col::text = 'v'`, which never materialises the enum value (used by the `projects_platform_connection_ck` CHECK in 0043); (b) put the ADD VALUE in a deploy that ships BEFORE the migration that uses it; (c) use a text column + CHECK instead of an enum.
- Migrations that ship AFTER the ADD VALUE has been applied in a previous deploy can use the literal freely — the restriction is only within the adding transaction.
- **Always test a migration against a database seeded with pre-migration rows, not just an empty one.** Recipe: `docker run -d --rm -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine`, copy `drizzle/` to /tmp and strip the new entries from `meta/_journal.json`, migrate to the old point, INSERT representative legacy rows, then migrate with the real folder. This also exercises the backfills, which are no-ops on an empty DB.

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

### [hits: 2] Devices on this box live in npx cache 35cf602f65bb4257 — NEVER purge it while the device is running
- Cache path: `~/.npm/_npx/35cf602f65bb4257/node_modules/opencara/dist/bin.js` (hash is for spec `opencara@latest`; a pinned spec like `opencara@0.112.1` gets a DIFFERENT hash dir).
- After publish, force a refresh: `rm -rf ~/.npm/_npx/35cf602f65bb4257 && npm exec opencara@latest`. The cache won't re-download otherwise (see user-wide lesson on `npm exec @latest` caching).
- 2026-07-16 incident: the cache dir backing the LIVE device process was deleted (~04:53 UTC) while the device kept running from memory. Every claude-acp job after that failed in ~3s with `[device] acp connection closed: child error: spawn claude-acp ENOENT` — `resolveLocalAcpAdapter` (`packages/cli/src/runner/acpRunner.ts`) does `existsSync` on `dist/claude-acp.js` *next to the (deleted) bundle* at job time, misses, and falls back to bare `claude-acp` on PATH, which doesn't exist. Non-claude ACP jobs (`npx pi-acp …`) and internal jobs kept succeeding, so the device looked healthy.
- Fix: kill the stale device (`pgrep -af 'npm exec opencara'` lineage) and relaunch detached: `cd ~ && setsid bash -c 'exec npm exec --yes opencara@latest' >> ~/opencara-device.log 2>&1 < /dev/null &`. It re-acks under the same host id (token in ~/.opencara). Then rerun failed flows from the failed step via the rerun API.
- Rule: any `rm -rf ~/.npm/_npx/<hash>` MUST be immediately followed by a device restart on that box. Device log lives at `~/opencara-device.log`.

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

## Shell / process management

### [hits: 2] `pkill -f` / `pgrep -f` match THEIR OWN shell command line — always bracket the pattern
- The Bash tool runs commands via `zsh -c '<the whole script>'`, so the script text itself is a process whose command line contains your pattern. `pkill -f "npm exec opencara"` therefore kills the shell running it.
- **Hit twice on 2026-08-12.** First benignly: `pgrep -f "src/index.ts"` reported "STILL RUNNING" while matching itself. Then destructively: a device-refresh script ran `pkill -f "npm exec opencara"` as step 1 of kill -> purge -> relaunch; pkill killed its own shell (exit 144), so the purge and relaunch never ran. Net effect: device killed and left DOWN with a stale cache — the exact 2026-07-16 incident state, self-inflicted.
- Fix: bracket one character so the pattern cannot match the literal text — `pkill -f "npm exec [o]pencara"`, `pgrep -f "[s]rc/index.ts"`. Or match precisely: `ps -eo pid,args --no-headers | grep -E "[n]pm exec opencara" | awk '{print $1}' | xargs -r kill`.
- Corollary for ANY kill -> purge -> relaunch sequence: verify each step's effect before assuming the next ran. A non-zero exit from the compound command means later steps silently did not happen. Confirm the process is gone AND the dir is gone AND the new process exists — never infer from "the command returned".

### [hits: 1] Killing `npm exec opencara` does NOT kill the device — the real process is a grandchild that survives as an orphan
- The device runs as a 3-process tree: `npm exec opencara@latest` -> `sh -c "opencara"` -> `node ~/.npm/_npx/<hash>/node_modules/.bin/opencara`. Only the LAST one is the device. Killing the `npm exec` wrapper leaves the grandchild running, reparented to init (PPID 1), still executing whatever code it loaded at start.
- 2026-08-12: after a botched refresh I checked with `ps ... grep "[n]pm exec [o]pencara"` — which only matches the WRAPPER — saw nothing, and concluded "device stopped". The real device (12 days old, PID with PPID 1) was still running. The relaunch then started a SECOND device sharing the same `agentHostId` from `~/.opencara/config.json`.
- Symptom of the duplicate: the orchestrator log alternates `connected` / `disconnected` with `code=4000 reason="superseded"` every second or so, and the reported version FLIPS between the two builds (0.113.1 / 0.112.3) as each evicts the other. **Any agent run dispatched into that churn fails with `device <id> disconnected`**, which is what killed flow run 01KZTXZJWMDAMXKCDX54EJAMWG.
- Correct check — match the BIN path, not the wrapper: `ps -eo pid,ppid,etime,args --no-headers | grep -E "_npx/[a-f0-9]+/node_modules/\.bin/opencara"`. An entry with PPID 1 and an etime much older than your relaunch is an orphan; kill it by exact PID.
- Two devices with one host id is silent apart from the log churn: `agent_hosts` shows a single row, `/health` is green, and the version column just reflects whichever said hello last.

## Multi-platform UI

### [hits: 1] A UI affordance for an optional platform must be gated on `/api/auth/providers`, not rendered unconditionally
- Shipped in v0.113.0 and broke immediately: `AddProjectPage` rendered a hardcoded `[GitHub | Azure DevOps]` tab strip, but the Azure routes only mount when `AZDO_ENTRA_*` is configured. On the GitHub-only prod deployment the tab was clickable and called `/api/azure/organizations`, which 404'd through the SPA fallback → "Failed to load organizations: API 404".
- The signal already existed and was already correct — `/api/auth/providers` returned `{github:true, entra:false}`, and `LoginPage` consumed it properly to hide the Microsoft button. The bug was one page ignoring it. **When adding a second consumer of a capability flag, share the query instead of re-deriving; two independent probes drift.** Both pages now use `authProvidersQuery()`.
- Generalization: the orchestrator mounts routes conditionally on config (GitHub App, Entra, both). Any new UI entry point for a platform needs the same gate, and a one-option switcher should not render at all.
- The build, 419 unit tests, and the azure-only boot probe ALL passed with this bug present — none of them render the page. The check that would have caught it is "load the actual page against a deployment that lacks the optional platform", which is also why the 404 branch now names the cause instead of surfacing a raw status.

## Azure DevOps

### [hits: 1] An INNER JOIN through `github_installations` silently hides every Azure DevOps project
- `projects.installation_id` is NULL for Azure DevOps projects (the connection lives in `azure_devops_connections`). Any query that INNER JOINs `github_installations` therefore drops them with no error — the row exists, the API returns 200, and the project is simply absent.
- Bit twice on 2026-08-12, both from the same root: `GET /api/projects` (project vanished from the list after being added successfully) and `GET /api/projects/:id` via `loadOwnedProjectWithInstallation` (would have rendered "Project not found." — the same string as the two unrelated causes already in this file).
- The multi-platform plan explicitly predicted this ("every ownership/ACL path grows a two-branch fork") and contained it in the ownership helpers — but MISSED queries that join inline instead of going through them. Containing a fork in a helper only works if every call site actually uses the helper.
- When adding a platform, grep for `innerJoin` + `githubInstallations` together and audit each: `auth/ownership.ts`, `routes/api/projects.ts`, `routes/api/chat.ts`, `routes/api/kanban.ts`. Use `loadOwnedProjectWithConnection` (LEFT joins both connection tables) on anything platform-neutral; the GitHub-only helper is correct only where the route is genuinely GitHub-specific.
- Symptom to recognise: "it says added / it exists in the DB, but it doesn't show up." That is a JOIN dropping the row, not a write failing.


### [hits: 1] Widening a GitHub-only ctx: use a discriminated union, not nullable fields
- When adding Azure DevOps to `NodeRunCtx` (2026-08-11), replacing `installation: {...}` with a `PlatformRunCtx` discriminated union (`{platform:"github",...} | {platform:"azure_devops",...}`) made `tsc` enumerate every site that had silently assumed GitHub — about 10 across nodeRunners/engine. Adding nullable `azdo*` fields alongside the existing ones would have compiled clean and failed at runtime on the first ADO run.
- Corollary: `ctx.app` (GithubAppClient) had to become optional, because an ADO-only deployment configures no GitHub App at all. `FlowEngine` is now constructed when EITHER platform is configured; it used to be `githubApp ? new FlowEngine(...) : null`, which would have left an ADO-only install with no engine and no error.
- Pattern for GitHub-only extras (auto-merge, PR↔issue link, draft-PR ready): a `skipOnAzure(ctx, feature)` helper that logs and returns true, rather than throwing. These run AFTER a successful agent step, so failing the run would discard completed work over a missing convenience.

### [hits: 1] Service hooks authenticate with HTTP Basic, not an HMAC signature — resolve the project BEFORE checking the secret
- GitHub signs each delivery (`x-hub-signature-256`) and one secret covers the whole App. Azure DevOps signs nothing: the Basic-auth password registered on the subscription is the entire inbound authentication, and it is stored per connection.
- Consequence for the handler (`routes/webhooksAzure.ts`): you cannot know which secret to compare against until you know which project the delivery is for. Resolve project → connection from the payload's repository/project GUID FIRST, then compare against exactly that connection's secret. Comparing against "any connection whose secret matches" would let one org's secret authenticate another org's events.
- Because the body is unsigned and the secret is long-lived, a replayed delivery is indistinguishable from a fresh one. Content dedup on the payload `id` (`platform_events.delivery_id`) is the only thing bounding replay — not the auth check.
- Azure DevOps **auto-disables a subscription** after repeated delivery failures, with no notification. Non-2xx from our endpoint is therefore load-bearing: unmapped event types and unknown repos return 200 (`ignored`/`unmatched`) on purpose, so a stray variant can't silently tear down a working hook. `listSubscriptions()` exists to spot ones that got disabled anyway.
- Subscriptions are per (team project, event type) and need HTTPS when basic auth is set — `PUBLIC_BASE_URL` on http:// makes every subscription creation fail with a 400.

## Webhooks

### [hits: 1] Duplicate reviews/runs come from GitHub at-least-once delivery, NOT a double webhook config
- Symptom: one fix push → two `pr-review` runs → two PR reviews seconds apart (e.g. PR #144, 2026-06-02).
- Root cause, in order: (1) the webhook endpoint at `opencara.quabug.de` is **timing out** — GitHub's App delivery log (`GET /app/hook/deliveries` with an App JWT from `opencara.private-key.pem`) showed every delivery `status=timed out, dur=10`. (2) A chronically slow endpoint makes GitHub **re-emit deliveries as fresh originals** (`redelivery=False`, distinct `x-github-delivery` GUIDs, identical `before`/`after` SHA). (3) `webhooks.ts` dedups only on the delivery GUID (`platform_events.id = x-github-delivery` + `.onConflictDoNothing()`), so two GUIDs for the same push = two `platform_events` rows = two `dispatchEvent` → two reviews.
- It is NOT caused by two webhook configs or two Apps: confirmed via `gh api repos/.../hooks` (none), `gh api orgs/OpenCara/hooks` (only a `projects_v2_item` kanban hook), and `platform_events.installation_id` on the dup events (both = prod App install `120583623`; `opencara-dev` install `117464084` was not the source). Don't go hunting for a duplicate subscription to delete — there isn't one.
- Two fixes, both needed: (a) **ack fast** — `return c.json({ok:true})` before the awaited DB work / move insert+dispatch off the response path, so GitHub stops timing out (the in-process flow dispatcher saturating the event loop is the likely staller). (b) **content-level idempotency** — dedup `pr-review` on `(projectId, eventType, action, after-SHA)` or skip if a review already exists for the PR's current head SHA; GUID-only dedup can't stop GitHub's legal duplicate originals.
- To inspect the App delivery log: mint an RS256 JWT (`iss`=GITHUB_APP_ID 3113278, `exp`<10min) signed with `packages/orchestrator/opencara.private-key.pem`, then `curl -H "Authorization: Bearer $JWT" https://api.github.com/app/hook/deliveries?per_page=100`.

## Architecture quirks

### [hits: 2] nodeRunners.ts contains intentional NUL bytes — grep/rg treat it as binary
- `packages/orchestrator/src/flows/nodeRunners.ts` uses literal `\x00` sentinel bytes in string literals (`"\x00ANYPATH\x00"` etc.) for glob-to-regex normalization. They are NOT corruption; the file compiles fine.
- Consequence: plain `grep`/`rg` silently return nothing (or "binary file matches") on this file. Searches that "find no matches" there are lying.
- Use `rg -na` / `grep -a` when searching it, and don't "clean up" the bytes.
- RECURS (2026-08-11, azure-devops phase 0): a `sed -i` rewrite of node kinds across several files succeeded here, but the *verification* `grep` printed nothing and briefly looked like the edit had missed the file. Verifying an edit is exactly when this bites — the edit worked, the check lied. Use `grep -a` (or `sed -n … | tr -d '\000'` to read a region) for any before/after check on this file.
- The `Edit` tool matches fine against regions with no NULs; only the shell text tools are affected.

### [hits: 1] `parseGraph` in routes/api/flows.ts + agent-calls/* is a shallow cast, NOT FlowDefinitionSchema
- There are two unrelated things named "parse a graph". `FlowDefinitionSchema.parse()` (zod) validates and applies defaults; the local `parseGraph()` helpers in `routes/api/flows.ts`, `agent-calls/flowNodeConfigSet.ts` (and the draft readers `currentGraph()` in `routes/api/flowTemplates.ts` + `agent-calls/templateNodeConfigSet.ts`) only null-check, `as`-cast and deep-clone. They deliberately tolerate graphs that no longer validate.
- Consequence: anything you implement *in the zod schema* — validation, defaults, kind normalization — does NOT apply on those four read paths, and those are the paths that feed the web canvas. Assuming "every graph read funnels through the schema" is wrong; verify before relying on it.
- Bit during the `github.*` → `scm.*` node-kind rename (2026-08-11): the zod preprocess normalized the engine's reads, but the flow/template detail endpoints would still have served pre-rename kinds to the UI. Fix was an explicit `normalizeGraphKinds()` call at each raw reader.
- When adding cross-cutting graph behaviour, grep for BOTH `FlowDefinitionSchema` and `parseGraph|currentGraph` and handle all of them.

### [hits: 1] agent_runs.spec.acp.priorSessionId is overwritten post-run with the RESULT session id
- `nodeRunners.ts` rewrites `spec.acp.priorSessionId` in place via `jsonb_set` after the run finishes, so the DB value is the session the run ENDED with, not what it resumed from. For claude-acp resume the two are equal (resume keeps the id); for fresh runs it's a brand-new UUID.
- To learn whether a run actually resumed, check the device-side pin `~/.opencara/sessions/<owner>/<repo>/branch-<safe>/agent-session.json` mtime vs the run time, or the Claude transcript under `~/.claude/projects/<munged-cwd>/<sessionId>.jsonl` (a fresh session has a single user turn).

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

### [hits: 1] Inlining a PEM into an env var: verify with createPrivateKey before shipping; /health green ≠ App auth working
- 2026-07-06 incident: the container cutover's `.env.production` was generated with a layered-quoting awk that ATE the PEM's newlines (headers glued to base64). `crypto.createPrivateKey` → `ERR_OSSL_UNSUPPORTED`, so EVERY GitHub-App call failed (PR context, token minting, kanban), while `/health` stayed green — octokit mints the App JWT lazily, and the engine swallows context-fetch errors (`[flow-engine] pr context fetch failed`), so flow runs surfaced only a misleading downstream error (`{{OPENCARA_PR_NUMBER}} not in run env`).
- Correct inlining: `sed -z 's/\n/\\n/g' key.pem` (literal `\n` escapes; config.ts un-escapes). ALWAYS verify the round-trip with `node -e "createPrivateKey(...)"` before deploying, and prefer a functional probe (App JWT → `GET /app` expecting 200) over the health endpoint when auth-critical env changed.
- Since PR #196 a malformed key fails loudly at boot → the deploy's health gate rejects the rollout. Diagnosis path for "flow failed with a weird template-var error": check `docker logs opencara_server | grep "pr context fetch failed"` — the template error is usually the SECOND-order symptom of a swallowed GitHub auth/API failure.

## GitHub tokens

### [hits: 1] GitHub installation tokens are NO LONGER always `ghs_`+alphanumerics — the new 390-char format contains dots and breaks strict `[\w-]` validation
- Symptom (2026-07-30, flow run `01KYS8NYV68M2P2TAP1K97AFAJ`, node `review_synthesizer`): `flow_runs.error` = `worktree allocation on host … exited with code 1: GH_TOKEN contains unexpected characters; refusing to use`. Intermittent — 239 successes vs 11 failures on the same host over 30 days, and the failure rate is RISING (a 20-sample mint probe on 2026-07-30 returned 7/20 bad).
- Root cause: `packages/cli/src/commands/internal.ts:87` guards the injected token with `/^[\w-]+$/`, and its comment asserts "GitHub installation tokens are ASCII alphanumerics". That assumption is now false. `POST /app/installations/{id}/access_tokens` returns, for a growing fraction of calls, a **390-char** token shaped `ghs_<48>.<254>.<86>` (three dot-separated segments, JWT-like) instead of the classic 40-char `ghs_`+36. Both are valid — the long ones authenticate fine (verified with `GET /repos/{owner}/{repo}`). GitHub is rolling the new format out progressively, which is exactly why it looks random.
- Do NOT chase the orchestrator side. The mint→inject path in `nodeRunners.ts` `dispatchAgentRun` is correct: `<ephemeral>` is only an audit marker written to `agent_runs.spec.env` BEFORE the real token is mutated onto the live `opts.env`, the dispatcher sends the in-memory spec (`devices.ts:587`), and the device merges `{...process.env, ...spec.env}` (`cli/src/commands/run.ts:302`) so spec wins. Seeing `<ephemeral>` in the persisted `agent_runs.spec.env` is EXPECTED and is not the leak. A mint *failure* deletes the key and produces the different error "worktree create needs GH_TOKEN in env".
- Fix: widen the guard to allow `.` (e.g. `/^[\w.-]+$/`). Safe because the git credential helper references the token **by name** (`'!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`, `internal.ts:133`) — the value never enters argv or `.git/config`, so the regex is defense-in-depth against shell metachars, not a correctness requirement. Keep rejecting whitespace/quotes/`$`/backticks.
- Probe to confirm the format distribution: mint N tokens with the app creds and print only `len`, `prefix`, and the set of chars failing `[A-Za-z0-9_-]` — never log the token; revoke each with `DELETE /installation/token`.

### [hits: 1] Containerized prod: secrets live in /opt/opencara/.env.production, not packages/orchestrator/.env
- Since the 2026-07-06 container cutover the running config is `/opt/opencara/.env.production` (chmod 600, owned by `quabug`), loaded via `env_file` in `/opt/opencara/docker-compose.prod.yml`. The older `packages/orchestrator/.env` note above is stale for prod.
- Quick query pattern: `export $(/usr/bin/grep -E "^DATABASE_URL=" /opt/opencara/.env.production) && psql "$DATABASE_URL" -c "..."`.
- Logs are `sg docker -c "docker logs opencara_server"` (NOT `/tmp/opencara-orchestrator.log`, which is pre-container and stale). `docker logs --since/--until` interpret bare timestamps as LOCAL time — append `Z` for UTC or you get zero lines and wrongly conclude the window is empty.

### [hits: 1] `npm publish --provenance` fails once the repo goes private — publish-cli silently blocks all device-side fixes
- 2026-07-30: tagging `v0.112.2` deployed the server fine but the `publish-cli` job died with `npm error 422 ... Error verifying sigstore provenance bundle: Unsupported GitHub Actions source repository visibility: "private". Only public source repositories are supported when publishing with provenance.` `v0.112.1` (2026-07-06) predates OpenCara/OpenCara going private, so this is latent breakage, not a regression from the tagged commit.
- Consequence worth internalizing: a `v*` tag fans out to TWO workflows (`deploy` → GHCR + SSH rollout, `publish-cli` → npm). They fail independently. A green `deploy` does NOT mean the CLI shipped — always check `npm view opencara version` after tagging, because **devices only ever get fixes through npm**.
- The old comment in publish-cli.yml claimed `--provenance` "activates npm's trusted-publishing OIDC exchange". That is WRONG and made the flag look load-bearing for auth. The OIDC exchange comes from `id-token: write` + npm >= 11.5.1 detecting the Actions OIDC env; `--provenance` only adds the sigstore attestation. Dropping it (PR #199) keeps trusted publishing working with no NPM_TOKEN.
- A failed publish leaves an orphan tag: `v0.112.2` exists as a git tag and a GHCR image with no matching npm version. Don't retry by moving/force-pushing the tag — cut the next patch (`v0.112.3`).
