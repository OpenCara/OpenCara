# Design: opencara-relay — streaming broker for agent tool output

**Status**: Draft — pending team-lead review, do NOT break down yet.
**Parent issue**: (to be created) "Epic: opencara-relay streaming broker".
**Author**: PM.
**Last updated**: 2026-04-20.

## 1. Goal & scope

Let contributors watch the AI tool (claude, codex, gemini, qwen, pi) think and act in real time while it reviews / implements / fixes a PR or issue. Agents run on the contributor's machine; the viewer runs in the browser on the GitHub PR/issue page. They need to meet somewhere — that meeting point is **opencara-relay**, a small pub/sub broker independent of the existing Cloudflare Worker.

**Non-goals for v1**:

- Replaying a run after it ends (no persistence).
- Two-way control (pause/cancel from the browser). Read-only stream.
- A polished dashboard / analytics. MVP renders raw events in a panel.
- Replacing the existing review posting mechanism. The relay is purely observational; the PR comment remains the authoritative review artifact.

---

## 2. Guiding principles

1. **Stateless except for the ring buffer** — any relay node can be restarted; in-flight subscribers reconnect and pick up from `cursor`. No DB, no Redis, no Durable Objects. (Restarts drop ring buffer contents — see §9.)
2. **Relay is dumb** — it verifies JWTs, routes messages per topic, keeps a short ring buffer, forwards everything else. No business logic about reviews, tasks, reputation, auth handshake, etc.
3. **Opt-in per contributor** — disabled by default. No relay URL configured → agent works exactly as today. Zero behavioral change for contributors who don't opt in.
4. **Zero platform cost preserved** — Fly.io free tier (or similar) in front. If Fly.io is unavailable we fall back to contributor self-hosting a `relay-node` Docker image.
5. **Tool output is untrusted** — the agent process streams raw tool stdout/stderr. The adapter normalizes. Raw untrusted content still has to be rendered safely in the extension (CSP, no innerHTML of tool output).
6. **Same monorepo, same TypeScript, same workspace conventions** — don't fork.

---

## 3. Event schema (the hardest part)

### 3.1 Envelope (every message)

```ts
interface RelayEnvelope {
  v: 1; // schema version, integer, bumped on breaking change
  topic: string; // e.g. "opencara/opencrust#726" or "task:abc123"
  seq: number; // monotonic per-topic sequence, assigned by relay on publish
  ts: number; // relay ingest timestamp (ms epoch)
  producer: string; // agent instance id, e.g. "agent:uuid/claude"
  event: RelayEvent; // see 3.2
}
```

`seq` is **relay-assigned**, not agent-assigned. This matters for correct ordering across retries and lets subscribers request `?since=<seq>` on reconnection. `v` allows additive extension without breaking old clients; breaking changes bump to `v: 2` and old clients get a `schema_mismatch` error event (see 3.3.7).

### 3.2 Event types

Common across all tools. Adapters map tool-native output to this vocabulary.

#### 3.2.1 Lifecycle

- `run_start` — `{ task_id, task_type ("review"|"summary"|"implement"|"fix"|"dedup"|"triage"|"issue_review"), tool, model, thinking_level?, pr_number?, issue_number?, owner, repo }`.
- `run_end` — `{ status ("ok"|"error"|"timeout"|"aborted"|"killed"), exit_code?, duration_ms, tokens?: { input, output, total }, reason? }`. Terminal.

#### 3.2.2 Model streaming

- `thinking_delta` — `{ text }`. Partial reasoning content. Appended to the current thinking block.
- `thinking_end` — `{}`. Seals the current thinking block.
- `text_delta` — `{ text }`. Partial final answer content. Appended to current assistant turn.
- `text_end` — `{}`. Seals the current text block.

#### 3.2.3 Tool calls (the model invoking its own tools, e.g. Read/Write/Bash)

- `tool_call_start` — `{ call_id, name, input_preview? }`. `input_preview` is redacted/truncated (see §11).
- `tool_call_result` — `{ call_id, ok, output_preview?, error? }`.

#### 3.2.4 Process I/O

- `stderr` — `{ text }`. Raw tool stderr line(s). Line-buffered.
- `log` — `{ level ("debug"|"info"|"warn"|"error"), message, meta? }`. Structured log from the adapter itself (not the tool).

#### 3.2.5 Heartbeat

- `heartbeat` — `{}`. Sent by agent every 15s during a run. Lets late subscribers detect liveness without replaying the whole ring.

#### 3.2.6 Error

- `error` — `{ code, message, retriable: boolean }`. Adapter-level error (e.g. tool crashed, parse failure). Non-terminal unless followed by `run_end`.

#### 3.2.7 Schema mismatch (relay → client)

- `schema_mismatch` — `{ server_v, client_v, message }`. Sent by relay as a synthesized event if a subscriber connects with a `v` the relay doesn't support.

### 3.3 Versioning

- `v: 1` is the MVP vocabulary. Additions (new event types, new fields) do **not** bump `v` — clients must ignore unknown event types and unknown fields.
- Removals, renames, semantic changes bump `v`. Relay negotiates version via connect handshake (query param `?v=1`). If the relay can't satisfy, it closes with `schema_mismatch`.

---

## 4. Topic naming

**Primary key**: `task_id` (UUID).

**Human-friendly alias**: `owner/repo#pr` or `owner/repo#issue-N`, which resolves (via lookup) to 0..N active task_ids.

Why both:

- **task_id** is unambiguous. A single PR can have multiple in-flight tasks (review + summary + fix). Subscribing to `task_id` gives you exactly one agent run.
- **owner/repo#N** is what the extension knows from the URL. The extension must be able to translate URL → list of active task_ids without the user typing anything.

**Resolution endpoint (on opencara-server)**: `GET /api/relay/topics?owner=X&repo=Y&pr=Z` (or `&issue=Z`) → `{ tasks: [{ task_id, role, agent_id, tool, model, started_at }] }`. The server already knows which tasks are in-flight — this is just a read. Requires user auth (GitHub OAuth, same as CLI today) because task_ids leak partial review state.

Extension UX: on PR page, the panel shows a "Live runs" list; user clicks one to subscribe. If only one is in-flight, auto-subscribe.

The relay itself doesn't know or care about `owner/repo#pr` — it only sees opaque topic strings. The mapping lives on opencara-server.

**Topic string format sent to relay**: `task:<uuid>`. Simple, opaque, unambiguous.

---

## 5. Auth handoff (JWT)

**Shared secret**: HS256 key provisioned as env var on both opencara-server and opencara-relay. (Asymmetric RS256 is overkill for v1 — one deployer controls both ends. Document that symmetric is a v1 choice.)

### 5.1 Publish token

Minted by `POST /api/relay/publish-token` on opencara-server. Caller: agent (CLI), authenticated with existing GitHub OAuth.

Request: `{ task_id }`.

Server validates: task exists, task is claimed by this agent (via existing OAuth identity), relay feature is enabled for this contributor.

Response:

```ts
{
  relay_url: string; // e.g. "wss://relay.opencara.dev/ws"
  sse_url: string; // "https://relay.opencara.dev/sse"
  publish_token: string; // JWT
  topic: string; // "task:<uuid>"
  ttl_seconds: number; // match task timeout + small grace
}
```

JWT claims:

```json
{
  "iss": "opencara-server",
  "aud": "opencara-relay",
  "sub": "agent:<agent_id>",
  "topic": "task:<uuid>",
  "scope": "publish",
  "exp": <unix>,
  "iat": <unix>,
  "jti": "<uuid>"
}
```

### 5.2 Subscribe token

Minted by `POST /api/relay/subscribe-token` on opencara-server. Caller: browser extension, authenticated with GitHub OAuth.

Request: `{ task_id }`.

Server validates: task exists, subscriber has repo access (public repo → allow; private → check collaborator access via GitHub API, same logic as `/api/tasks/poll`).

Response: same shape as publish, with `scope: "subscribe"` and a shorter TTL (e.g. 1h — subscribers re-fetch on expiry).

### 5.3 Relay verification

Relay verifies: signature, `aud === "opencara-relay"`, `exp > now`, `scope` matches the endpoint being called, `topic` matches the connect parameter. On failure, close with 4001 (WS) or 401 (SSE).

---

## 6. Relay protocol

### 6.1 WebSocket

- Connect: `wss://<relay>/ws?topic=<topic>&v=1&since=<seq?>&token=<jwt>`
- Token passed via **first WS message** (`{"type":"auth","token":"..."}`) instead of query string to avoid logging tokens in proxy access logs. Query-string token is a fallback for clients that can't do app-level auth.
- After auth: relay sends ring buffer events (from `since` if given, else last N), then live.
- Publisher: opens WS with `scope: "publish"` token. Sends raw event objects (no envelope — relay wraps and assigns seq). One connection per topic per agent.
- Subscriber: opens WS with `scope: "subscribe"` token. Receives envelopes.
- Heartbeat: relay sends `{"type":"ping"}` every 20s. Clients reply `{"type":"pong"}`. Missing 2 pongs → close.

### 6.2 SSE (subscribe-only)

- Connect: `GET https://<relay>/sse?topic=<topic>&v=1&since=<seq?>` with `Authorization: Bearer <jwt>`.
- Each event: `event: data\ndata: <json envelope>\nid: <seq>\n\n`. Subscriber can reconnect with `Last-Event-ID` header, which relay treats as `since`.
- Heartbeat: `: ping\n\n` every 20s.
- Publishing via SSE is not supported (agents use WS).

### 6.3 Ring buffer

- Per topic, fixed-size array (default N=200).
- On publish, append, drop oldest.
- On subscribe, if `since=X` is given: replay events with `seq > X` still in the buffer; if `X` is older than the buffer, send one `buffer_truncated` synthesized event and start from oldest-in-buffer.
- Empty ring after all subscribers disconnect + no publisher → garbage collect after 5 minutes idle. (Terminal events `run_end` + idle → earlier GC after 60s.)

### 6.4 Reconnection semantics

- Subscriber holds the last `seq` it saw. Reconnects with `?since=<seq>`.
- Publisher holds the last `seq` _it published_. On reconnect, retransmits events with local `seq > last_acked`. Relay dedupes by `jti` inside `run_start` / `run_end` and by `(producer, local_seq)` for streaming events. (Agent assigns local_seq independent of relay-global seq; relay still stamps its own `seq`.)

---

## 7. Package layout

```
packages/
  shared/                  (unchanged — REST API types)
  server/                  (+ new mint-token endpoints, + topic lookup)
  cli/                     (+ relay publish integration via wrapper — opt-in)
  relay/                   (NEW — the broker server, deployable)
  relay-client/            (NEW — shared client, zero runtime deps, used by cli + extension)
  relay-adapters/          (NEW — per-tool stream parsers; importable by cli)
  extension/               (NEW — browser extension MVP)
```

- `packages/relay` — Node.js (not Workers — need WS, long-lived connections). Hono or uWebSockets.js. One entry point: `relay-node` (Docker image). Ring buffer in-process.
- `packages/relay-client` — isomorphic, no Node-only deps. Provides `RelayPublisher` and `RelaySubscriber` classes. Handles auth, reconnection, backoff, ring-buffer replay.
- `packages/relay-adapters` — one module per tool: `claude.ts`, `codex.ts`, `gemini.ts`, `qwen.ts`, `pi.ts`. Each exports `createAdapter(stdin, stdout, stderr, emit)` that parses tool-native stream and calls `emit(event)`.
- `packages/extension` — MVP: a content script injected on `github.com/*/*/pull/*` pages. Uses `relay-client` via SSE (CORS-friendly, no WS complexity in content scripts). Panel UI is plain HTML + minimal CSS.

**Why separate `relay-client` and `relay-adapters`**: the relay-client is a pure transport. Adapters are parsers. They compose: the CLI pipes tool subprocess through an adapter into a publisher. The extension only needs the client.

---

## 8. Agent wrapper integration

### 8.1 Current flow (unchanged path)

`packages/cli/src/tool-executor.ts` spawns the tool subprocess and collects stdout/stderr into strings. `review.ts` / `implement.ts` etc. call `executeTool(cmd, prompt, timeout, ...)` and consume the full `ToolExecutorResult` at the end.

### 8.2 New flow (when relay is enabled)

1. Before spawning, agent calls `POST /api/relay/publish-token` and gets `{ relay_url, publish_token, topic }`.
2. Agent creates a `RelayPublisher(relay_url, publish_token, topic)` — opens WS, buffers events if disconnected.
3. `executeTool` is refactored to accept an optional `streamHandler: (chunk) => void` for stdout. When the adapter is present, each chunk is fed to the adapter, which calls `emit(event)` → publisher.
4. `run_start` is emitted before spawn, `run_end` is emitted on close with final status. `stderr` events are emitted line-by-line.
5. Final `ToolExecutorResult` is still returned exactly as today — no change to callers (review.ts, implement.ts, etc.). Relay is a tap, not a replacement.

**Per-tool adapter interface**:

```ts
interface StreamAdapter {
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
  onClose(exitCode: number | null, signal: string | null): void;
}

type AdapterFactory = (emit: (event: RelayEvent) => void, ctx: RunContext) => StreamAdapter;
```

Tool-native streaming formats:

- **claude** (claude-code CLI) — emits JSON lines on stdout when invoked with `--output-format stream-json`. Parser extracts `thinking`, `text`, `tool_use`, `tool_result`, `usage`.
- **codex** — human-readable text; adapter splits on known section headers and emits `text_delta` + optional `tool_call_*` when it recognizes its tool blocks. Token usage parsed from footer.
- **gemini** (gemini-cli) — streams text; simplest adapter, just `text_delta` from stdout.
- **qwen** — JSON stats footer; otherwise text stream.
- **pi** — currently not in `packages/cli/tools/` (only claude/codex/gemini/qwen TOMLs exist). Ship the adapter interface so it can be added when the tool is registered; don't block v1 on it.

Unknown tools → generic adapter that emits `text_delta` for stdout and `stderr` for stderr. Always works, just no tool-call granularity.

### 8.3 Opt-in knob

`.opencara/config.toml` (contributor's CLI config):

```toml
[relay]
enabled = true
url = "https://relay.opencara.dev"   # or self-hosted
# No auth config here — publish tokens minted per-task by opencara-server.
```

Absent `[relay]` → relay is off, zero change from today.

---

## 9. Browser extension scope (MVP)

**Recommendation**: **inline panel on the PR page**, not a separate localhost dashboard.

Why inline:

- Agent-runs-on-different-machine is the whole point; a localhost dashboard breaks that. User wants to watch _from any browser they're using_.
- PR page is where the user is already. Zero context switch.
- SSE from content script is well-understood; `fetch` works, no WS quirks.

Why not localhost dashboard (rejected):

- Requires agent machine = viewer machine. Regresses on the stated use case.
- Extra process to run.

**MVP feature set**:

- Content script injected on `github.com/<owner>/<repo>/pull/<n>` (and `/issues/<n>`).
- Fetches `/api/relay/topics?...` via contributor's GitHub OAuth token (same token used by CLI; the extension does its own Device Flow OAuth once and stores the token).
- If 1 active task → auto-subscribe. If multiple → show list.
- Collapsed by default; expanding shows a scrollable stream of events with basic styling per type (thinking = muted, text = normal, tool_call = badge, stderr = red).
- Disconnect + reconnect button.
- No persistence across page reloads (ring buffer replay is enough for the contributor's live-watching need).

**Out of scope for MVP (defer)**:

- Full Manifest V3 packaging for Chrome Web Store / Firefox AMO. Ship an unpacked dev extension first; Store submission is a later sub-issue.
- Settings UI beyond a single "relay URL" input.
- Any cross-tab state sharing.

---

## 10. Deployment

**Primary**: [Fly.io](https://fly.io) free tier. One small VM (256 MB RAM) easily handles hundreds of concurrent WS. Fly.io has free tier, WS support, TLS termination.

**Fallbacks**:

- [Railway](https://railway.app) (500h/month free on hobby).
- Small VPS (Hetzner €4/month).
- Self-host: `docker run -p 8080:8080 -e RELAY_JWT_SECRET=... opencara/relay:latest`.

**Operational concerns**:

- Restart = ring buffer loss. Acceptable. Agents reconnect & keep publishing; subscribers reconnect from new `seq`. A run that was mid-way just loses its history before the restart.
- Single instance for v1. No clustering. (Clustering needs shared pub/sub — Redis or NATS — kicks us out of free tier. Defer.)
- Metrics: simple `/metrics` Prometheus endpoint. Topic count, WS connection count, SSE connection count, events/sec. No logging of event payloads.

**Dev/prod parity**:

- `relay-dev.opencara.dev` for main-branch auto-deploy (mirrors dev worker pattern).
- `relay.opencara.dev` for tagged prod deploys.
- Both use different JWT secrets (server env config holds both, picks based on `env`).

---

## 11. Failure modes

| Failure                      | Behavior                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay down                   | Agent's publisher queues events (bounded queue, e.g. 1000) and keeps trying. If queue overflows → log warning, drop oldest, continue. Review itself is unaffected — relay is a tap.                                                   |
| Agent crashes mid-run        | Publisher closes; subscribers see heartbeats stop. After 30s of no heartbeat, relay synthesizes `run_end { status: "aborted", reason: "publisher disconnect" }`. Ring buffer keeps content for late joiners.                          |
| Browser closes tab           | Subscriber disconnects; relay decrements refcount. Run continues on agent side. If it reopens within ring-buffer lifetime, replays.                                                                                                   |
| Token expires mid-run        | Publisher refreshes via `POST /api/relay/publish-token` (server re-verifies task still owned by this agent). Subscriber refreshes via `/subscribe-token`. On refresh failure → close connection with `4003 auth_expired`.             |
| Relay node restart           | Ring buffers lost. All connections drop. Clients reconnect with `since=` but buffer is empty → they get `buffer_truncated` + live from there.                                                                                         |
| Clock skew                   | `exp` has 60s leeway.                                                                                                                                                                                                                 |
| Malicious publisher          | JWT topic claim must match connect topic; otherwise close. One publish token → one topic. Agent can't publish to another task.                                                                                                        |
| Extension replay attack      | Subscribe tokens are short-TTL. Topic access is gated by GitHub repo access at mint time; if user loses access mid-run, their existing token still works until expiry (documented limitation — not worth re-checking on every event). |
| Ring buffer overflow (burst) | Fixed size, lossy. Subscribers see `buffer_truncated` if they fall behind. Agent doesn't back off — it's the observer's problem.                                                                                                      |

---

## 12. Security & privacy

**What flows through the relay**:

- Prompt (contains PR diff, file contents, PR metadata, custom repo prompt).
- Model thinking (can contain reasoning about code, file paths, suspected bugs).
- Tool call inputs/outputs (can contain file contents, bash output, git history).
- Stderr.

This is the same content the AI tool sees — nothing _new_ is exposed, but it's exposed to a different party (the relay operator), whereas today it only touches the contributor's machine and the AI provider.

**Mitigations**:

1. **Opt-in per contributor** — off by default. Documented that enabling shares the stream with the relay.
2. **Opt-in per repo** — `.opencara.toml` can set `[relay] enabled = false` to disable relay for this repo even if the contributor enabled it. Repo owner can opt out.
3. **Payload size caps** — `tool_call_result.output_preview`, `tool_call_start.input_preview`, `thinking_delta.text`, `text_delta.text` all truncated to 4 KB per event. Full content stays local. Preview is enough to watch a run; full transcript is the PR comment posted at the end.
4. **Rate limit**: 50 events/sec per topic at the relay. Exceed → relay drops and emits `error { code: "rate_limit" }`. Encourages adapters to coalesce deltas.
5. **Max connections**: 20 subscribers per topic. Exceed → `4008 too_many_subscribers`.
6. **No server-side logging of event payloads**. Only connection-level metadata (topic, duration, seq count).
7. **TLS required**. HTTP and plain WS rejected at the edge.
8. **Redaction hook**: adapters can register a redactor that runs before emit. v1 ships with a default redactor that drops lines matching common secret patterns (AWS key, GitHub token, etc.). Same sanitize regex already used in `packages/cli/src/sanitize.ts`.

---

## 13. Open questions for team-lead

1. **JWT signer**: single HS256 shared secret for v1 — OK? Or do you want RS256 with the server holding the private key and the relay holding the public key? HS256 is simpler; RS256 is defensible if we ever run the relay as a separate operator. My recommendation: HS256 for v1, migrate later if needed.
2. **Topic naming on the wire**: I propose opaque `task:<uuid>`. The owner/repo/pr lookup stays on opencara-server. Are you OK with the extension making two round trips (lookup tasks → subscribe)?
3. **Ring buffer size**: 200 events is a guess. A chatty model with 10 tool calls + 50 thinking deltas + 50 text deltas hits ~120 events. 200 feels right for "joined ~30s late, can still catch up". Open to tuning.
4. **Extension OAuth**: do we reuse the CLI's GitHub OAuth app, or register a separate GitHub OAuth app for the extension? Separate app is cleaner scope-wise but adds setup cost. Recommend: reuse the CLI app for v1, split later if needed.
5. **pi adapter**: tool isn't registered in `packages/cli/tools/` yet. Does v1 need to support it, or can we ship with claude/codex/gemini/qwen + generic adapter and add pi when the tool TOML lands? Recommend: defer pi to a follow-up sub-issue.
6. **Payload cap — 4 KB per event**: too strict? The trade-off is relay memory (ring × subscribers) vs. rendering fidelity. 4 KB cap × 200 ring × 20 subs ≈ 16 MB per topic worst-case — acceptable. Could relax to 8 KB.
7. **`relay-dev` vs. contributor self-hosted default**: do we host the dev relay and invite contributors to use it (and foot the bill / bear the trust), or ship relay-only and force self-hosting? Recommend: platform-hosted dev relay (small) + well-documented self-host. Prod follows same pattern.
8. **Extension distribution**: OK to ship unpacked dev extension for v1 (users install via "Load unpacked")? Chrome Web Store submission can be a follow-up issue.

---

## 14. Proposed sub-issue list (NOT CREATED YET)

All sub-issues gated on your approval of this doc. Default agent assignments in brackets.

### Foundation (blocks everything else)

| #   | Title                                                                                                                            | Agent     | Deps |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| R1  | Add relay event schema types to `packages/shared` (RelayEnvelope, RelayEvent variants, v1)                                       | architect | —    |
| R2  | Define `/api/relay/publish-token`, `/api/relay/subscribe-token`, `/api/relay/topics` request/response types in `packages/shared` | architect | R1   |

### opencara-server side

| #   | Title                                                                                           | Agent      | Deps   |
| --- | ----------------------------------------------------------------------------------------------- | ---------- | ------ |
| R3  | Implement `/api/relay/publish-token` endpoint — mint HS256 JWT, verify task ownership via OAuth | server-dev | R2     |
| R4  | Implement `/api/relay/subscribe-token` endpoint — verify repo access, mint subscribe JWT        | server-dev | R2     |
| R5  | Implement `/api/relay/topics` endpoint — list active tasks for owner/repo/pr or issue           | server-dev | R2     |
| R6  | Wire RELAY_JWT_SECRET and RELAY_URL env vars into wrangler config + docs                        | server-dev | R3, R4 |

### packages/relay (the broker)

| #   | Title                                                                            | Agent     | Deps          |
| --- | -------------------------------------------------------------------------------- | --------- | ------------- |
| R7  | Scaffold `packages/relay` Node server, Hono + ws, Dockerfile, basic health check | architect | R1            |
| R8  | JWT verification middleware — HS256, scope/topic/exp checks                      | architect | R7, R6        |
| R9  | Topic registry + ring buffer (per-topic, size 200, GC on idle)                   | architect | R7            |
| R10 | WS publisher endpoint — first-message auth, seq assignment, fan-out              | architect | R7, R8, R9    |
| R11 | WS subscriber endpoint — `?since=` replay + live                                 | architect | R7, R8, R9    |
| R12 | SSE subscriber endpoint — `Last-Event-ID` resume + heartbeats                    | architect | R7, R8, R9    |
| R13 | Rate limits + max subscribers per topic                                          | architect | R10, R11, R12 |
| R14 | `/metrics` Prometheus endpoint                                                   | architect | R7            |
| R15 | Fly.io deployment config + dev-deploy CI workflow (mirrors deploy-dev.yml)       | architect | R7            |

### packages/relay-client + adapters

| #   | Title                                                                                                                        | Agent     | Deps |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| R16 | Scaffold `packages/relay-client` — `RelayPublisher` (WS, queue, reconnect) and `RelaySubscriber` (WS + SSE, `since=` resume) | architect | R1   |
| R17 | Scaffold `packages/relay-adapters` — StreamAdapter interface + generic fallback adapter                                      | architect | R1   |
| R18 | Claude adapter — parse `--output-format stream-json`, map to thinking/text/tool_call events                                  | cli-dev   | R17  |
| R19 | Codex adapter — text stream + token-footer detection                                                                         | cli-dev   | R17  |
| R20 | Gemini adapter — simple text stream                                                                                          | cli-dev   | R17  |
| R21 | Qwen adapter — text stream + qwen JSON stats footer                                                                          | cli-dev   | R17  |

### CLI integration

| #   | Title                                                                                                                                  | Agent   | Deps         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------ |
| R22 | Add `[relay]` section to CLI config.toml parsing                                                                                       | cli-dev | R1           |
| R23 | Refactor `tool-executor.ts` to accept optional stream handler for stdout/stderr                                                        | cli-dev | R16, R17     |
| R24 | Wire relay publish into review.ts + implement.ts + fix.ts + summary.ts + issue-review.ts + dedup.ts + triage.ts — behind config toggle | cli-dev | R22, R23, R3 |
| R25 | Add default redactor using existing `sanitize.ts` patterns                                                                             | cli-dev | R17          |

### Extension MVP

| #   | Title                                                                                                          | Agent   | Deps         |
| --- | -------------------------------------------------------------------------------------------------------------- | ------- | ------------ |
| R26 | Scaffold `packages/extension` — Manifest V3, content script injector for `github.com/*/pull/*` and `/issues/*` | cli-dev | R16          |
| R27 | Extension GitHub Device Flow OAuth (reuse CLI app)                                                             | cli-dev | R26          |
| R28 | Topic lookup + subscriber UI panel (live event list, per-type styling)                                         | cli-dev | R26, R5, R16 |
| R29 | Reconnection/cursor UX + disconnect button                                                                     | cli-dev | R28          |

### Docs + ops

| #   | Title                                                        | Agent | Deps      |
| --- | ------------------------------------------------------------ | ----- | --------- |
| R30 | `docs/relay.md` — architecture, security, self-hosting guide | pm    | all above |
| R31 | `docs/extension.md` — install + use                          | pm    | R29       |

**Total**: ~31 sub-issues. Critical path (R1 → R2 → R7 → R9 → R10/R11 → R16 → R23 → R24) is ~8 issues. Extension MVP is a parallel track after R16.

---

## 15. Breakdown approval checklist

Before PM creates sub-issues, team-lead please confirm:

- [ ] Event schema in §3 is the right vocabulary (or propose changes).
- [ ] Topic naming: `task:<uuid>` on wire, server resolves URL → tasks.
- [ ] Auth: HS256 JWT, mint endpoints on opencara-server.
- [ ] Package layout: 4 new packages (`relay`, `relay-client`, `relay-adapters`, `extension`).
- [ ] Extension: inline panel on PR page, not localhost dashboard.
- [ ] Deployment: Fly.io primary, self-host via Docker.
- [ ] Opt-in: contributor config + repo `.opencara.toml` both can disable.
- [ ] Redaction: reuse `sanitize.ts`, 4 KB per-event cap.
- [ ] Answers to Open Questions in §13.
- [ ] Scope: pi adapter and Chrome Web Store publish deferred.

On approval, PM will create the Epic + ~31 sub-issues with full specs, leave them in Backlog, and wait for team-lead to move the foundation issues to Ready.
