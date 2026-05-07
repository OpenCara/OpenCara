# MCP server smoke-test runbook

Verifies the #28 building blocks end-to-end on a developer machine. The CI
unit tests (`pnpm --filter opencara test`) cover IPC framing, tool
registration, the WS bridge, and `McpHost` lifecycle deterministically.
This runbook covers what unit tests can't: a real ACP agent spawning
`opencara-mcp`, a real IPC dial-back, and (optionally) a real orchestrator
applying the mutation.

## Prerequisites

- Gemini CLI installed locally (`gemini --version` works) with ACP support.
  `--experimental-acp` is the default invocation; override via
  `OPENCARA_ACP_ARGS` if your installed version uses a different flag.
- `GEMINI_API_KEY` exported.
- `tsx` available on the local PATH (it ships in the workspace; `pnpm exec`
  finds it automatically).

## Step 1: Stub-backed end-to-end

Launches Gemini with `opencara-mcp` configured. The IPC server runs in a
small harness process that returns a stub success for any tool call (no
orchestrator required). Confirms:

- `opencara-mcp` boots, dials the IPC socket, exposes the three tools.
- Gemini sees the tools via ACP's `mcpServers` config and can call them.
- Tool result round-trips back through the IPC into Gemini's context.

```bash
# From the repo root:
pnpm --filter opencara mcp:smoke "set the body of issue 1 to 'hello from gemini'"
```

Expected stdout (abridged):

```
[smoke] mcp socket: /tmp/opencara-mcp-smoke-<id>.sock
[smoke] launching: gemini --experimental-acp ...
[update] agent_message_chunk: I'll update the issue body...
[smoke] tool-call: opencara_issue_body_set { issueNumber: 1, bodyMd: '...' }
[smoke]   stub returning { ok: true }
[update] tool_call_update <id> status=completed
[update] agent_message_chunk: I've updated the issue body.
[smoke] stopReason=end_turn
```

If the run hangs at "launching", Gemini's ACP entrypoint flag is wrong —
override:

```bash
OPENCARA_ACP_ARGS='--acp' pnpm --filter opencara mcp:smoke "..."
```

## Step 2: Force a domain rejection

```bash
OPENCARA_MCP_SMOKE_REJECT=1 \
  pnpm --filter opencara mcp:smoke "set the body of issue 99999 to 'bad'"
```

Expected: the stub returns `{ ok: false, reason: "stub: rejected" }`. Gemini
should mention the rejection in its reply rather than silently proceeding.

## Step 3: Concurrent isolation (manual)

Run two `mcp:smoke` invocations from two terminals at the same time. Each
gets its own per-run socket path (`/tmp/opencara-mcp-smoke-<id>.sock`).
The two harnesses must never see each other's tool calls — verified by
matching `runId` echoes in each terminal's `[smoke] tool-call:` output.

## Step 4: Real orchestrator (optional, on opencara.com host)

Once #29 cuts over the chat path, the same flow can be exercised against a
real orchestrator + DB. Until then, drive it manually:

1. On the production host, register a device (`opencara run`) and pair it.
2. Create a run via the orchestrator API with a `mcpServers` field
   pointing at `opencara-mcp` (path on the device's filesystem).
3. Trigger a chat message that asks the agent to mutate an issue body.
4. Observe the issue's `draftBodyMd` change in the DB.
5. The agent's chat reply should reference the success (or failure) of the
   tool call.

Capture the wire frames (Gemini stderr, opencara-mcp's IPC, the device
WS) for any future debugging — the smoke harness writes everything to
`./.opencara-mcp-smoke/frames-<timestamp>.jsonl`.

## What this runbook does NOT cover

- Claude / Codex via their respective ACP adapters. Those adapters are
  pinned in #29.
- The chat route reshaping that builds `mcpServers` from `McpHost`. That's
  also #29.
- MiniMax-M2.5 — no upstream ACP adapter; behavior tracked in #30.
