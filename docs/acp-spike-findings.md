# ACP client spike findings

Verification log for issue #27. Populate the empirical sections by running
`packages/cli/src/acp/spike.ts` against a locally-installed ACP-speaking
agent (Gemini CLI is the primary target — native ACP support, no third-party
adapter in the path).

## How to run the spike

```bash
# 1. Install Gemini CLI (or another native-ACP agent) on the local machine.
# 2. Set the auth env var the agent expects (e.g. GEMINI_API_KEY).
# 3. Run from the repo root:

tsx packages/cli/src/acp/spike.ts "summarize the current directory"
```

Override the binary if the default (`gemini --experimental-acp`) doesn't
match your installed version:

```bash
OPENCARA_ACP_COMMAND=gemini \
OPENCARA_ACP_ARGS='--experimental-acp' \
OPENCARA_ACP_CWD="$PWD" \
tsx packages/cli/src/acp/spike.ts "summarize the current directory"
```

Frames land at `$OPENCARA_ACP_DUMP_DIR/frames-<timestamp>.jsonl` (defaults to
`./.opencara-acp-spike/`). One JSON-RPC message per line, annotated with
direction (`in` = agent→client, `out` = client→agent) and timestamp.

## Already known from the spec source

These came from reading
[`zed-industries/agent-client-protocol@0.4.5`](https://github.com/zed-industries/agent-client-protocol/tree/main/typescript)
(the `typescript/` directory in the package tarball — not browseable on
the repo's `main` branch, which is the Rust crate). They don't need spike
verification, but we list them so contributors don't relearn them.

| Question | Answer | Source |
|---|---|---|
| Wire framing | Newline-delimited JSON. Each frame = compact JSON-RPC 2.0 message + `\n`. **No** Content-Length headers. Empty lines dropped silently. | `typescript/stream.ts:ndJsonStream` |
| Protocol version | `1` (a plain integer, not semver). Sent as `protocolVersion` in `initialize` request and response. | `typescript/schema.ts:PROTOCOL_VERSION` |
| Method names | `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/set_model`, `authenticate` (agent-side); `session/update`, `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*` (client-side). | `typescript/schema.ts:AGENT_METHODS,CLIENT_METHODS` |
| `session/new` request shape | `{ cwd: string; mcpServers: McpServer[]; _meta?: object }` | `typescript/schema.ts:newSessionRequestSchema` |
| `session/new` response shape | `{ sessionId: string; modes?: ...; models?: ...; _meta?: object }` | `typescript/schema.ts:newSessionResponseSchema` |
| `session/prompt` request shape | `{ sessionId: string; prompt: ContentBlock[]; _meta?: object }` | `typescript/schema.ts:promptRequestSchema` |
| `session/prompt` response shape | `{ stopReason: "end_turn" \| "max_tokens" \| "max_turn_requests" \| "refusal" \| "cancelled"; _meta?: object }` | `typescript/schema.ts:promptResponseSchema` |
| `session/update` notification shape | `{ sessionId: string; update: <discriminated union on sessionUpdate> }`. Variants include `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`. | `typescript/schema.ts:sessionNotificationSchema` |
| ContentBlock variants | `text`, `image`, `audio`, `resource_link`, `resource`. Spike sends only `text`. | `typescript/schema.ts:contentBlockSchema` |
| Notifications expect a response? | No — JSON-RPC 2.0 notifications never get one. `session/cancel` is fire-and-forget. | JSON-RPC 2.0 spec |
| Pre-1.0 churn risk | The spec is `protocolVersion: 1` but the npm package version is `0.4.5`. Pin a version when we add a runtime dep on adapters. | `package.json` |

## Empirical findings (fill in by running the spike)

Each row below was a question in #27's verification matrix. Capture a
concrete frame example or a one-line answer per row. If a row is "didn't
observe", say so explicitly — silence is ambiguous.

### 1. Gemini's actual ACP invocation

`gemini --acp` (the registry-default `--experimental-acp` is now deprecated
in `@google/gemini-cli@0.41.2`). The spike harness's default has been
updated; #28 also pulled `smoke.ts` in line with this.

If you don't have `gemini` installed globally, `npx --yes
@google/gemini-cli --acp` works as a drop-in via:

```
OPENCARA_ACP_COMMAND=npx OPENCARA_ACP_ARGS='--yes @google/gemini-cli --acp' \
  pnpm --filter opencara acp:spike "<prompt>"
```

### 2. `initialize` round-trip

```jsonc
// out:
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":1,"clientCapabilities":{}}}

// in:
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "agentInfo":{"name":"gemini-cli","title":"Gemini CLI","version":"0.41.2"},
  "agentCapabilities":{
    "loadSession":true,
    "promptCapabilities":{"image":true,"audio":true,"embeddedContext":true},
    "mcpCapabilities":{"http":true,"sse":true}
  },
  "authMethods":[
    {"id":"oauth-personal","name":"Log in with Google","description":"Log in with your Google account"},
    {"id":"gemini-api-key","name":"Gemini API key","description":"Use an API key with Gemini Developer API"},
    {"id":"vertex-ai","name":"Vertex AI","description":"Use an API key with Vertex AI GenAI API"},
    {"id":"gateway","name":"AI API Gateway","description":"Use a custom AI API Gateway"}
  ]
}}
```

Notable:
- `loadSession: true` — Gemini supports `session/load`. We can persist a
  Gemini sessionId and resume on subsequent turns (matches the legacy
  `--resume <uuid>` model).
- `mcpCapabilities.http` and `.sse` are advertised, but stdio is what
  Gemini actually expects in `mcpServers` — confirmed against #28's smoke.
- `authMethods` is informational. Setting `GEMINI_API_KEY` in env is
  sufficient; we did not call `authenticate` at all.

### 3. `session/new` round-trip

```jsonc
// out:
{"jsonrpc":"2.0","id":2,"method":"session/new",
 "params":{"cwd":"/path","mcpServers":[/* see #28 host.acpServerEntry() */]}}

// in:
{"jsonrpc":"2.0","id":2,"result":{
  "sessionId":"<uuid>",
  "modes":{"availableModes":[
    {"id":"default","name":"Default","description":"Prompts for approval"},
    {"id":"autoEdit","name":"Auto Edit","description":"Auto-approves edit tools"},
    {"id":"yolo","name":"YOLO","description":"Auto-approves all tools"},
    {"id":"plan","name":"Plan","description":"Read-only mode"}
  ],"currentModeId":"default"},
  "models":{"availableModels":[/* gemini-3.x, gemini-2.5 variants */],
            "currentModelId":"auto-gemini-3"}
}}
```

`sessionId` lands in the response immediately — no side-channel updates
first.

### 4. `session/prompt` and the streamed updates

`session/update` discriminators observed in real runs:
- `available_commands_update` — fires immediately after `session/prompt`.
  Lists agent slash commands (`memory`, `extensions`, `init`, etc.). Our
  client logs this as `(unmodeled)`; not load-bearing for the cutover.
- `agent_thought_chunk` — Gemini emits its planning prose here.
- `tool_call` (status: `in_progress`) and `tool_call_update` (status:
  `completed` / `failed`) for both internal "think" tools and our MCP
  tools.

### 5. Turn-end signal

The `session/prompt` response with `stopReason` is the canonical end-of-turn
signal. Not directly observed in our smoke (Gemini turns hung mid-flight on
the dev key — likely API-side rate limiting), but matches the spec.

### 6. Tool calls in the wild

**Critical finding:** Gemini issues `session/request_permission` for every
MCP tool call, regardless of advertised client capabilities. If the client
returns method-not-found, Gemini marks the tool call `failed` and surfaces
`[object Object]` to the user.

```jsonc
// in (request from agent → client, expects a response):
{"jsonrpc":"2.0","id":N,"method":"session/request_permission",
 "params":{
   "sessionId":"…",
   "toolCall":{"toolCallId":"…"},
   "options":[
     {"kind":"reject_once","name":"…","optionId":"…"},
     {"kind":"allow_once","name":"…","optionId":"…"},
     {"kind":"allow_always","name":"…","optionId":"…"}
   ]
 }}

// out (auto-allow, matches today's --dangerously-skip-permissions):
{"jsonrpc":"2.0","id":N,"result":{
   "outcome":{"outcome":"selected","optionId":"<allow_once option id>"}
}}
```

The auto-allow handler is implemented in `AcpConnection.dispatch` in PR
#32 (the `session_request_permission` branch). Real permission UI is
out of scope until #29 has a chat-side permission flow to route to.

### 7. Agent→client requests we didn't expect

Only `session/request_permission` (covered above). `fs/read_text_file`,
`fs/write_text_file`, and the `terminal/*` family were NOT requested even
though Gemini has the capability — presumably because we advertised
`clientCapabilities: {}`.

### 8. Stderr usage

Empty modulo npm warnings (when launched via `npx`). Gemini doesn't write
anything diagnostic to stderr that we'd want to surface to operators.

## Decisions captured for #28/#29

- **MCP server transport posture:** stdio-local. Gemini accepts the
  `{type:"stdio", command, args, env}` shape directly; the device hosts an
  IPC socket that opencara-mcp dials back to (per #28's `McpHost`).
- **Tool-call-result wire path:** Option A (extend device WS with
  `agent-call-request` / `agent-call-result`). Implemented in #28.
- **Permission flow stance:** Auto-allow client-side, matching today's
  `--dangerously-skip-permissions`. The handler is small enough to keep
  inline in `AcpConnection`. When the chat path lands a permission UI in
  a later milestone, swap the handler for one that routes to the user.
- **Adapter package(s) to pin:** Defer until #29 — Claude/Codex adapters
  haven't been smoke-tested yet.

## Risks observed during the spike

- **Permission round-trip is mandatory, not optional.** Any agent we
  integrate must have its `session/request_permission` requests handled
  *before* MCP tools become callable. Discovered the hard way: we shipped
  #27 with a method-not-found default, and the first end-to-end smoke
  for #28 failed with `[object Object]` until the auto-allow handler
  landed.
- **Gemini CLI deprecates `--experimental-acp` in favor of `--acp`.**
  Both still work in 0.41.2 but the deprecation will eventually bite.
  Default flag updated in `acp:spike` and `mcp:smoke` scripts.
- **API quota on dev keys hangs prompts mid-flight.** Smoke runs that
  exhausted a small dev quota stalled silently after `session/prompt`,
  with no error frame and no stderr — just `available_commands_update`
  and then nothing. Validate against a fresh key before declaring a hang
  a code bug.
