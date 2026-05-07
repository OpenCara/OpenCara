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

What command + flag actually puts Gemini CLI into ACP mode on your machine?

> _TODO: paste the working command from the spike run, including version of
> Gemini CLI tested. If `--experimental-acp` is wrong, log the correct flag._

### 2. `initialize` round-trip

Paste both directions of the frame.

```jsonc
// out:
// in:
```

What does Gemini advertise in `agentCapabilities`? Specifically: `loadSession`,
`mcpCapabilities`, `promptCapabilities`?

> _TODO_

Does Gemini return any `authMethods` in the response?

> _TODO_

### 3. `session/new` round-trip

Paste both directions.

```jsonc
// out:
// in:
```

Did `session/new` return a `sessionId` immediately, or did the agent emit
side-channel updates first? (Affects how the chat route persists run state
in #29.)

> _TODO_

### 4. `session/prompt` and the streamed updates

Paste the request frame, then a representative sequence of incoming
`session/update` notifications until the prompt response arrives.

```jsonc
// out (prompt):
// in (update 1):
// in (update 2):
// …
// in (prompt response):
```

Which `sessionUpdate` discriminators did Gemini actually emit? List each
one observed and how often.

> _TODO_

### 5. Turn-end signal

How does the agent signal "turn over"? Confirm: it's the `session/prompt`
response with `stopReason`, not a sentinel `session/update` notification?

> _TODO_

### 6. Tool calls in the wild

Run the spike with a prompt that should make Gemini use a tool (e.g. "list
files in this directory"). Paste a `tool_call` and its `tool_call_update`
sequence.

```jsonc
// in (tool_call):
// in (tool_call_update progress):
// in (tool_call_update completed):
```

Did Gemini run the tool autonomously, or did it issue a
`session/request_permission` to the client? (We advertised no client
capabilities — observe how Gemini handles that.)

> _TODO_

### 7. Agent→client requests we didn't expect

Did the agent attempt to call any client method (e.g. `fs/read_text_file`)?
The spike replies method-not-found by default; check the dump for
`out` direction frames carrying an error response.

> _TODO_

### 8. Stderr usage

Did the agent write anything to stderr during the run? If so, what?

> _TODO_

## Decisions captured for #28/#29

These follow from the empirical findings — do not commit to them until the
sections above are populated.

- **Adapter package(s) we'll pin:** _TODO (e.g. `@zed-industries/claude-agent-acp@0.16.x`)._
- **MCP server transport posture:** stdio-local vs. orchestrator-hosted. _TODO once we've seen how Gemini surfaces tool calls and request_permission._
- **Tool-call-result wire path:** options are (a) extend the device WS with request/response pairs, or (b) make the CLI device run the MCP server itself and skip the round-trip. Pick after #28's spike.
- **Permission flow stance:** if all agents in our stack run tools without `request_permission` round-trips when client capabilities are empty, we keep parity with today's `--dangerously-skip-permissions` posture and don't model permissions in #29. Otherwise, surface a no-op auto-approve in the client.

## Risks observed during the spike

> _TODO_ — append anything that surprised you. Spec gaps, unexpected fields,
> agent-specific quirks, env var requirements, etc.
