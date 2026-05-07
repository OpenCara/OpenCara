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
//     --session-id <uuid> --dangerously-skip-permissions <prompt>` and
//     pipes its JSONL stdout through the translator.
//   - Translates exactly two Claude events:
//       * `{type:"assistant", message:{content:[{type:"text",text}]}}`
//          → `session/update` `agent_message_chunk` (text)
//       * `{type:"result", subtype, is_error, ...}`
//          → resolves the prompt request with `stopReason`
//     Everything else is dropped silently (no harm, just no surfacing).
//   - `--session-id <uuid>` keeps Claude's own session continuity
//     across turns within an ACP session — same model the legacy
//     `claudeAdapter` used. Resume across ACP sessions via
//     `session/load` is a follow-up.
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
  /** Stable across all turns of this ACP session — passed to every
   *  `claude --session-id` invocation so Claude maintains its own
   *  conversation memory. */
  claudeSessionId: string;
  cwd: string;
}

const sessions = new Map<string, SessionState>();

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
): Promise<ClaudePromptResult> {
  return new Promise<ClaudePromptResult>((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      // Required for stream-json output per Claude's CLI contract —
      // without it Claude refuses on the grounds that streaming makes
      // sense only when stdin can be partial too.
      "--include-partial-messages",
      "--verbose",
      "--session-id",
      state.claudeSessionId,
      // Headless: no human in the loop to approve tool use. Matches the
      // legacy `claudeAdapter` posture in agents/kinds.ts.
      "--dangerously-skip-permissions",
      promptText,
    ];
    const child = spawn("claude", args, {
      cwd: state.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
    child.on("close", (code) => {
      if (!resolved) {
        // No `result` event — claude died unexpectedly. Surface as a
        // refusal so the orchestrator marks the run failed (vs a clean
        // end_turn which looks like a successful empty response).
        resolved = true;
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
    const message = msg["message"] as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const blocks = message?.content ?? [];
    for (const block of blocks) {
      if (block?.type !== "text") continue;
      const text = typeof block.text === "string" ? block.text : "";
      if (text.length === 0) continue;
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    }
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

function handleInitialize(_params: InitializeParams): unknown {
  return {
    protocolVersion: 1,
    agentInfo: {
      name: "opencara-claude-acp",
      title: "opencara Claude shim",
      version: "0.0.1",
    },
    agentCapabilities: {
      // No session resume yet (follow-up). MCP via stdio works because
      // the `claude` CLI itself supports `mcpServers` in settings.json
      // but we don't propagate ACP's mcpServers config in this MVP.
      loadSession: false,
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

function handleNewSession(params: NewSessionParams): unknown {
  const sessionId = randomUUID();
  // Claude's own session id — distinct from the ACP sessionId so we can
  // remap if Claude rejects the id format. Today they're both UUIDs,
  // but keeping them separate is cheap insurance.
  sessions.set(sessionId, {
    claudeSessionId: randomUUID(),
    cwd: params.cwd ?? process.cwd(),
  });
  return { sessionId };
}

interface PromptParams {
  sessionId: string;
  prompt: Array<{ type: string; text?: string }>;
}

async function handlePrompt(params: PromptParams): Promise<unknown> {
  const state = sessions.get(params.sessionId);
  if (!state) {
    throw new Error(`unknown sessionId: ${params.sessionId}`);
  }
  // Concatenate all text content blocks into Claude's CLI prompt arg.
  // Image / embedded-context / audio aren't supported here yet — a
  // future PR threads them through `--input-format stream-json`.
  const promptText = params.prompt
    .filter((b) => b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n\n");
  if (promptText.length === 0) {
    throw new Error("session/prompt: no text content blocks");
  }
  const result = await runClaudeTurn(params.sessionId, state, promptText);
  return { stopReason: result.stopReason };
}

// ─── stdio main loop ───────────────────────────────────────────────

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

async function dispatch(msg: JsonRpcMessage): Promise<void> {
  // Notification (no id) — clients send `session/cancel` etc. We don't
  // implement cancellation in MVP; drop silently.
  if (!("id" in msg) || msg.id == null) return;
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
    replyError(
      req.id,
      err instanceof Error && message.startsWith("session/prompt:")
        ? JSON_RPC_ERROR_INVALID_PARAMS
        : JSON_RPC_ERROR_INTERNAL,
      message,
    );
  }
}
