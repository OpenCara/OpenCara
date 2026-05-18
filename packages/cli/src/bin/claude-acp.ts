#!/usr/bin/env node
//
// claude-acp: thin ACP-server shim around the local `claude` CLI.
//
// Why this exists instead of using @zed-industries/claude-agent-acp:
// the upstream adapter pulls in the Claude Agent SDK + 30+ event-type
// translations (compaction, hooks, task lifecycle, slash commands, etc.).
// For opencara's chat use case we need the bare minimum: stream the
// assistant's text reply back, end the turn cleanly. We accept the
// fidelity gap (no compaction/hook/task surfacing today) in exchange
// for not carrying the third-party adapter in our critical path.
// Extend as gaps surface in practice.
//
// Wire model:
//   - Speaks ACP on its own stdio (we are the agent in this layer).
//   - Per `session/prompt`, spawns `claude -p --output-format stream-json
//     <id-flag> --dangerously-skip-permissions`, writes the prompt text
//     to claude's stdin, and pipes its JSONL stdout through the
//     translator. Stdin (not argv) carries the prompt so large
//     flow-injected contexts don't trip Linux's per-string execve cap
//     (MAX_ARG_STRLEN, 128 KiB on a 4 KiB-page host).
//   - Translates exactly two Claude events:
//       * `{type:"assistant", message:{content:[{type:"text",text}]}}`
//          → `session/update` `agent_message_chunk` (text)
//       * `{type:"result", subtype, is_error, ...}`
//          → resolves the prompt request with `stopReason`
//     Everything else is dropped silently (no harm, just no surfacing).
//   - The ACP `sessionId` IS the Claude CLI session UUID. Choice of
//     id-flag depends on whether the JSONL already exists on disk:
//       * `session/new` → first prompt uses `--session-id <uuid>`
//         (creates a fresh session under that id). After that prompt
//         the JSONL exists, so the in-process state flips and any
//         later prompt on the same session uses `--resume <uuid>`.
//       * `session/load` → every prompt uses `--resume <uuid>`. The
//         orchestrator only calls `session/load` after a prior run
//         persisted the id, so the JSONL is expected to exist; using
//         `--session-id` on an existing JSONL fails with "Session ID
//         is already in use" and exits 1.
//   - `session/load` does NOT replay history via `session/update`
//     notifications. The Claude CLI handles replay internally; the
//     ACP client (orchestrator) doesn't need a synthesized stream.
//
// Loaded by the device when an ACP-mode chat picks up a `claude`
// agent kind (via `acp-gate.ts:ACP_ADAPTERS`).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stdin, stdout, stderr, exit } from "node:process";
import {
  encodeFrame,
  FrameDecoder,
} from "../acp/framing.js";
import {
  JSON_RPC_ERROR_INVALID_PARAMS,
  JSON_RPC_ERROR_INTERNAL,
  JSON_RPC_ERROR_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../acp/jsonrpc.js";

// ─── Wire helpers ──────────────────────────────────────────────────

function send(msg: JsonRpcMessage): void {
  stdout.write(encodeFrame(msg));
}

function reply(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } } satisfies JsonRpcResponse);
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

// ─── State ─────────────────────────────────────────────────────────

interface SessionState {
  /** ACP `sessionId` doubles as Claude's session UUID. Carrying just
   *  the cwd here is enough — the id is the map key. Single UUID for
   *  both layers means resume across processes works: the orchestrator
   *  passes the same id back via `session/load` next iteration and
   *  Claude CLI replays from
   *  `~/.claude/projects/<cwd-hash>/<id>.jsonl`. */
  cwd: string;
  /** Whether the next prompt should resume an existing Claude session
   *  (`--resume <uuid>`) instead of creating a new one
   *  (`--session-id <uuid>`). `session/load` sets this true; a
   *  `session/new` followed by a successful first prompt flips this
   *  true so subsequent in-process turns also resume. Required
   *  because Claude rejects `--session-id` against an existing JSONL
   *  with "Session ID is already in use" (exit 1). */
  resume: boolean;
  /** Reference to the in-flight `claude` child for this session, if
   *  any. `session/cancel` SIGTERMs this so the orchestrator's Stop
   *  button surfaces an immediate teardown instead of waiting on the
   *  shim's 2s force-close grace. Cleared in `runClaudeTurn`'s close
   *  handler. */
  activeChild?: ReturnType<typeof spawn> | null;
}

export const sessions = new Map<string, SessionState>();

// ─── Claude launcher ───────────────────────────────────────────────

interface ClaudePromptResult {
  /** ACP `stopReason` derived from Claude's `result.subtype` and `is_error`. */
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
}

/**
 * Run a single Claude turn. Streams `agent_message_chunk` updates as
 * the assistant text arrives; resolves with the stop reason when
 * Claude emits its terminal `result` event.
 */
async function runClaudeTurn(
  sessionId: string,
  state: SessionState,
  promptText: string,
  permissionMode: PromptParams["permissionMode"],
): Promise<ClaudePromptResult> {
  return new Promise<ClaudePromptResult>((resolve, reject) => {
    // `--session-id` *creates* a session under the given UUID and
    // errors if the JSONL already exists; `--resume` attaches to an
    // existing one. See SessionState.resume for why we track this.
    const idFlag = state.resume ? "--resume" : "--session-id";
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      // Required for stream-json output per Claude's CLI contract —
      // without it Claude refuses on the grounds that streaming makes
      // sense only when stdin can be partial too.
      "--include-partial-messages",
      "--verbose",
      idFlag,
      sessionId,
    ];
    // Per-turn permission knob from the chat panel toolbar. The two
    // modes are mutually exclusive with `--dangerously-skip-permissions`
    // — passing both makes claude exit immediately with an arg-parse
    // error, so we keep the headless default ONLY when the orchestrator
    // didn't explicitly opt into a mode for this turn.
    if (permissionMode && permissionMode !== "default") {
      args.push("--permission-mode", permissionMode);
    } else {
      // Headless: no human in the loop to approve tool use. Matches the
      // legacy `claudeAdapter` posture in agents/kinds.ts.
      args.push("--dangerously-skip-permissions");
    }
    // Prompt goes on stdin, not argv. Linux's execve caps a single
    // argv string at MAX_ARG_STRLEN (32 * PAGE_SIZE = 128 KiB on the
    // common 4 KiB-page kernel), and flow runs that inject the full
    // GitHub PR JSON into pageContextJson routinely exceed that —
    // node's `spawn` then throws `E2BIG` synchronously before claude
    // is exec'd, so the shim died in <1s with zero stderr and the
    // operator just saw "agent exited with code 1". Stdin has no
    // such per-string limit.
    const child = spawn("claude", args, {
      cwd: state.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    state.activeChild = child;
    // EPIPE if claude exits before we finish writing — the exit is
    // already observable on `close`, so we don't need to surface the
    // write failure twice.
    child.stdin.on("error", () => {});
    child.stdin.end(promptText);

    const decoder = new FrameDecoder();
    let resolved = false;
    let stopReason: ClaudePromptResult["stopReason"] = "end_turn";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const { messages, malformed } = decoder.feed(chunk);
      for (const line of malformed) {
        // Claude sometimes interleaves bare error text on stdout under
        // adverse conditions. Surface verbatim on stderr so operators
        // can see it without polluting the chat panel.
        stderr.write(`[claude-acp] malformed: ${line}\n`);
      }
      for (const msg of messages) {
        // FrameDecoder types incoming frames as JsonRpcMessage (used by
        // the rest of acp/), but Claude's stream-json speaks its own
        // shape — coerce through unknown and let the handler narrow.
        handleClaudeEvent(sessionId, msg as unknown, (sr) => {
          if (resolved) return;
          resolved = true;
          stopReason = sr;
        });
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr.write(chunk);
    });
    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    child.on("close", (code, signal) => {
      state.activeChild = null;
      if (!resolved) {
        resolved = true;
        // SIGTERM almost always means session/cancel killed us — surface
        // as cancelled so the orchestrator's `done` carries stopReason
        // "cancelled" instead of looking like an unrelated crash.
        if (signal === "SIGTERM" || signal === "SIGINT") {
          resolve({ stopReason: "cancelled" });
          return;
        }
        // No `result` event — claude died unexpectedly. Surface as a
        // refusal so the orchestrator marks the run failed (vs a clean
        // end_turn which looks like a successful empty response).
        if (code !== 0) {
          stderr.write(`[claude-acp] claude exited code=${code} without result event\n`);
          resolve({ stopReason: "refusal" });
          return;
        }
      }
      resolve({ stopReason });
    });
  });
}

/**
 * Map one parsed Claude JSONL event to ACP `session/update` notifications.
 * Calls `done(stopReason)` exactly once, when the terminal `result`
 * frame arrives.
 */
function handleClaudeEvent(
  sessionId: string,
  raw: unknown,
  done: (stopReason: ClaudePromptResult["stopReason"]) => void,
): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const msg = raw as Record<string, unknown>;
  const type = typeof msg["type"] === "string" ? (msg["type"] as string) : "";
  if (type === "assistant") {
    // With `--include-partial-messages`, the `assistant` frame carries
    // the CUMULATIVE final message — claude already streamed every
    // delta via `stream_event content_block_delta` frames before this.
    // Forwarding both produces the user-visible "reply repeated twice"
    // bug we hit on first opencara@0.104.0 run. Drop this frame; the
    // streaming chunks already covered the full text.
    //
    // If a future claude version stops emitting deltas (e.g. user
    // disables --include-partial-messages), this branch becomes the
    // fallback — but the spawn always passes that flag, so today the
    // assistant frame is purely redundant.
    return;
  }
  if (type === "stream_event") {
    // Claude emits incremental delta events when --include-partial-messages
    // is set. The shape is a Server-Sent-Events frame from Anthropic's API
    // wire format. For MVP we only forward `content_block_delta` text
    // deltas — everything else (start/stop markers, message_start, etc.)
    // is metadata the chat panel doesn't need.
    const event = msg["event"] as
      | { type?: string; delta?: { type?: string; text?: string } }
      | undefined;
    if (event?.type !== "content_block_delta") return;
    if (event.delta?.type !== "text_delta") return;
    const text = typeof event.delta.text === "string" ? event.delta.text : "";
    if (text.length === 0) return;
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
    return;
  }
  if (type === "result") {
    const subtype = typeof msg["subtype"] === "string" ? (msg["subtype"] as string) : "";
    const isError = msg["is_error"] === true;
    if (isError) {
      // Claude failure (rate limit, prompt too long, etc.) — surface
      // the result text as a final chunk so the operator sees what
      // went wrong, then refusal-stop.
      const resultText = typeof msg["result"] === "string" ? (msg["result"] as string) : "";
      if (resultText.length > 0) {
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `\n\n[claude error: ${resultText}]` },
          },
        });
      }
      done("refusal");
      return;
    }
    // success_max_turns / success_max_tokens map onto ACP's enum.
    if (subtype === "error_max_turns") {
      done("max_turn_requests");
      return;
    }
    if (subtype === "error_max_tokens") {
      done("max_tokens");
      return;
    }
    done("end_turn");
    return;
  }
  // Other event types (system/init, system/status, tool_use, tool_result,
  // user mid-turn echo, etc.) — drop silently. Extend as needed.
}

// ─── ACP request handlers ──────────────────────────────────────────

interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: unknown;
}

export function handleInitialize(_params: InitializeParams): unknown {
  return {
    protocolVersion: 1,
    agentInfo: {
      name: "opencara-claude-acp",
      title: "opencara Claude shim",
      version: "0.0.1",
    },
    agentCapabilities: {
      // Session resume works by passing the ACP sessionId back as
      // `claude --session-id <uuid>` on the next prompt — Claude CLI
      // replays its own JSONL internally. MCP via stdio is not yet
      // propagated from ACP's mcpServers config (the `claude` CLI uses
      // settings.json for that today; bridging is a separate change).
      loadSession: true,
      mcpCapabilities: {},
      promptCapabilities: { embeddedContext: false, image: false, audio: false },
    },
    authMethods: [],
  };
}

interface NewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
}

export function handleNewSession(params: NewSessionParams): unknown {
  const sessionId = randomUUID();
  sessions.set(sessionId, { cwd: params.cwd ?? process.cwd(), resume: false });
  return { sessionId };
}

interface LoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers?: unknown[];
}

export function handleLoadSession(params: LoadSessionParams): unknown {
  // The orchestrator persists the (kind, id) pair after each successful
  // run and replays it here on the next iteration. We register the id
  // in our in-memory map and mark it for resume; Claude CLI handles the
  // actual conversation replay on the next `--resume <id>` invocation
  // by reading `~/.claude/projects/<cwd-hash>/<id>.jsonl`. If that file
  // has been pruned, `claude --resume` will surface its own error,
  // which propagates to the operator instead of being papered over.
  if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
    throw new Error("session/load: sessionId required");
  }
  sessions.set(params.sessionId, { cwd: params.cwd ?? process.cwd(), resume: true });
  return {};
}

interface PromptParams {
  sessionId: string;
  prompt: Array<{ type: string; text?: string }>;
  /** Opencara extension — see PromptRequest in packages/cli/src/acp/types.ts. */
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
}

async function handlePrompt(params: PromptParams): Promise<unknown> {
  const state = sessions.get(params.sessionId);
  if (!state) {
    throw new Error(`unknown sessionId: ${params.sessionId}`);
  }
  // Concatenate all text content blocks into the text we pipe to
  // claude on stdin. Image / embedded-context / audio aren't supported
  // here yet — a future PR threads them through `--input-format
  // stream-json`.
  const promptText = params.prompt
    .filter((b) => b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n\n");
  if (promptText.length === 0) {
    throw new Error("session/prompt: no text content blocks");
  }
  const result = await runClaudeTurn(
    params.sessionId,
    state,
    promptText,
    params.permissionMode,
  );
  // After a successful first turn, Claude has written the JSONL under
  // this id — subsequent turns on the same session must `--resume`, or
  // Claude will reject `--session-id` with "already in use". We flip
  // unconditionally on completion: even if the turn ended in refusal,
  // claude still creates the session file before failing.
  state.resume = true;
  return { stopReason: result.stopReason };
}

interface CancelParams {
  sessionId: string;
}

function handleCancel(params: CancelParams): void {
  const state = sessions.get(params.sessionId);
  if (!state) return;
  const child = state.activeChild;
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch (err) {
    stderr.write(
      `[claude-acp] session/cancel kill failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ─── stdio main loop ───────────────────────────────────────────────

// Guard the side effects so the module is importable from unit tests
// without attaching to the real stdin or installing process exit
// handlers. The bin entry (`opencara claude-acp`) sets argv[1] to this
// file's path; tests import the module directly.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("claude-acp.ts") === true ||
  process.argv[1]?.endsWith("claude-acp.js") === true;

if (isMainModule) {
  const decoder = new FrameDecoder();

  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    const { messages, malformed } = decoder.feed(chunk);
    for (const line of malformed) {
      stderr.write(`[claude-acp] malformed inbound: ${line}\n`);
    }
    for (const msg of messages) void dispatch(msg);
  });
  stdin.on("end", () => {
    exit(0);
  });
}

async function dispatch(msg: JsonRpcMessage): Promise<void> {
  // Notification (no id). We handle `session/cancel` (kills the
  // active claude child for the session, surfacing the Stop button
  // through to the underlying process); any other notification we
  // don't recognise is dropped silently.
  if (!("id" in msg) || msg.id == null) {
    const notification = msg as { method?: string; params?: unknown };
    if (notification.method === "session/cancel") {
      const params = notification.params as CancelParams | undefined;
      if (params && typeof params.sessionId === "string") {
        handleCancel(params);
      }
    }
    return;
  }
  // Response from a client request to us — we don't make any
  // client→agent requests in this MVP, so any response is unexpected.
  if ("result" in msg || "error" in msg) return;

  const req = msg as JsonRpcRequest;
  try {
    switch (req.method) {
      case "initialize":
        reply(req.id, handleInitialize(req.params as InitializeParams));
        return;
      case "session/new":
        reply(req.id, handleNewSession(req.params as NewSessionParams));
        return;
      case "session/load":
        reply(req.id, handleLoadSession(req.params as LoadSessionParams));
        return;
      case "session/prompt": {
        const result = await handlePrompt(req.params as PromptParams);
        reply(req.id, result);
        return;
      }
      default:
        replyError(
          req.id,
          JSON_RPC_ERROR_METHOD_NOT_FOUND,
          `method not implemented: ${req.method}`,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isParamsError =
      err instanceof Error &&
      (message.startsWith("session/prompt:") || message.startsWith("session/load:"));
    replyError(
      req.id,
      isParamsError ? JSON_RPC_ERROR_INVALID_PARAMS : JSON_RPC_ERROR_INTERNAL,
      message,
    );
  }
}
