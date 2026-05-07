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

## Step 4: Chat-route end-to-end (#29, codex behind a flag)

#29 wires the chat route to use the ACP+MCP path for `kind: "codex"`
agents when `OPENCARA_ACP=1`. To exercise it on the dev host:

1. Restart the orchestrator with the flag set:

   ```bash
   OPENCARA_ACP=1 pnpm -r dev
   ```

2. In the dashboard, create or edit a Codex agent (`agents` table row
   with `kind = "codex"`). Command/args don't matter on this path — the
   chat route hardcodes `npx --yes @zed-industries/codex-acp`.

3. Make sure your chosen device has `OPENAI_API_KEY` exported in its
   environment (`opencara run` inherits it).

4. Open the chat panel on `IssueDetailPage` for any issue, ask the
   codex agent to update the body. Watch the panel SSE stream:
   - You should see `[think] …`, `[tool] opencara_issue_body_set
     (in_progress)`, then `→ completed`, then the agent's final reply.
   - The issue's `draftBodyMd` should change in the DB.

5. Try a non-codex agent with the flag still on — the chat route
   should return 400 with a clear "ACP cutover allowlist" error.

6. Disable the flag (restart without `OPENCARA_ACP`) and re-run with
   any agent: behavior must be bit-identical to before #29.

### Known limitations of #29 MVP

- Each chat turn opens a fresh ACP session; the agent has no memory of
  prior turns beyond what the orchestrator replays via `acp.history`
  (a single text block prepended to the prompt). Persisting the codex
  sessionId for `session/load` is a follow-up.
- The published `opencara` npm package's bundle does not include
  `opencara-mcp` yet; the ACP path requires running from a source
  checkout. Build pipeline updates land before #30 ships.
- Other agents (Claude / pi / opencode) stay on the legacy stdin-JSON
  path. #30 cuts them over and deletes the legacy code.

## What this runbook does NOT cover

- Claude / Codex via their respective ACP adapters. Those adapters are
  pinned in #29.
- The chat route reshaping that builds `mcpServers` from `McpHost`. That's
  also #29.
- MiniMax-M2.5 — no upstream ACP adapter; behavior tracked in #30.
