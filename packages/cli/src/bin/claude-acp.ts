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
//   - Translates a small set of Claude events:
//       * `{type:"stream_event", event:{type:"content_block_delta",
//          delta:{type:"text_delta",text}}}`
//          → `session/update` `agent_message_chunk` (text)
//       * `{type:"assistant", message:{content:[{type:"tool_use",
//          name:"AskUserQuestion", input:{...}}, ...]}}`
//          → `session/update` `agent_message_chunk` carrying a
//          ```json options fence per question, so the chat panel
//          renders the AskUserQuestion options as clickable buttons.
//          Text blocks inside assistant frames are dropped because the
//          stream_event deltas above already covered them.
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
  /** MCP servers from ACP `session/new` / `session/load` params. Claude
   *  CLI doesn't read ACP-side mcpServers natively — we bridge them via
   *  `--mcp-config <json>` + `--strict-mcp-config` on every turn so the
   *  agent's tool list actually contains the opencara-mcp tools the
   *  orchestrator advertised. Empty / absent → no bridge flags added. */
  mcpServers?: AcpMcpServer[];
}

/** ACP `session/new` `mcpServers` array element. Mirrors the shape the
 *  orchestrator builds in `packages/cli/src/mcp/host.ts:acpServerEntry`.
 *  We accept it as `unknown[]` at the wire and narrow to this here. */
interface AcpMcpServer {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

function normalizeMcpServers(raw: unknown): AcpMcpServer[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpMcpServer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e["type"] !== "stdio") continue; // only stdio servers today
    if (typeof e["name"] !== "string" || typeof e["command"] !== "string") continue;
    const args = Array.isArray(e["args"]) ? (e["args"] as unknown[]).map(String) : [];
    const env: Array<{ name: string; value: string }> = [];
    if (Array.isArray(e["env"])) {
      for (const kv of e["env"] as unknown[]) {
        if (!kv || typeof kv !== "object") continue;
        const r = kv as Record<string, unknown>;
        if (typeof r["name"] !== "string" || typeof r["value"] !== "string") continue;
        env.push({ name: r["name"], value: r["value"] });
      }
    }
    out.push({
      type: "stdio",
      name: e["name"] as string,
      command: e["command"] as string,
      args,
      env,
    });
  }
  return out;
}

/** Convert ACP-shape MCP servers into the JSON Claude CLI expects from
 *  `--mcp-config`. Claude's shape (from its settings.json /
 *  `--mcp-config` docs):
 *    { "mcpServers": { "<name>": { command, args, env: {KEY: VAL} } } }
 *  Returns a single-line JSON string suitable for passing on argv. */
function buildClaudeMcpConfig(servers: AcpMcpServer[]): string {
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const s of servers) {
    const env: Record<string, string> = {};
    for (const kv of s.env) env[kv.name] = kv.value;
    mcpServers[s.name] = { command: s.command, args: s.args, env };
  }
  return JSON.stringify({ mcpServers });
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
    // Bridge the ACP-side `mcpServers` from session/new+load through to
    // Claude. Without this, Claude CLI relies on `~/.claude/settings.json`
    // and never spawns opencara-mcp, so the agent's tool list is missing
    // every opencara_* tool — the chat skill then describes tools the
    // model genuinely can't reach. `--mcp-config` accepts an inline JSON
    // string; `--strict-mcp-config` makes that file the *only* source so
    // unrelated user-global MCP servers don't leak into chat runs.
    if (state.mcpServers && state.mcpServers.length > 0) {
      args.push(
        "--mcp-config",
        buildClaudeMcpConfig(state.mcpServers),
        "--strict-mcp-config",
      );
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
 * Pure translator: maps one parsed Claude JSONL event to zero or more
 * ACP `session/update` notifications plus an optional terminal stopReason.
 *
 * Kept side-effect-free so unit tests can assert the translated output
 * directly without spying on stdout.
 */
export interface AcpUpdateNotification {
  method: "session/update";
  params: { sessionId: string; update: Record<string, unknown> };
}

export interface TranslatedEvent {
  notifications: AcpUpdateNotification[];
  stopReason?: ClaudePromptResult["stopReason"];
}

export function translateClaudeEvent(
  sessionId: string,
  raw: unknown,
): TranslatedEvent {
  const out: AcpUpdateNotification[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { notifications: out };
  }
  const msg = raw as Record<string, unknown>;
  const type = typeof msg["type"] === "string" ? (msg["type"] as string) : "";
  if (type === "assistant") {
    // With `--include-partial-messages`, the `assistant` frame carries
    // the CUMULATIVE final message — claude already streamed every
    // text delta via `stream_event content_block_delta` frames before
    // this. Forwarding text twice produces the user-visible "reply
    // repeated twice" bug we hit on first opencara@0.104.0 run.
    //
    // We DO inspect this frame for `tool_use` blocks we want to surface
    // to the chat panel (e.g. AskUserQuestion → option buttons), since
    // tool_use isn't carried by the text-delta stream. Text blocks here
    // are still skipped to avoid the dedup bug.
    const message = msg["message"];
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const translated = translateAssistantBlock(sessionId, block);
          if (translated) out.push(...translated);
        }
      }
    }
    return { notifications: out };
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
    if (event?.type !== "content_block_delta") return { notifications: out };
    if (event.delta?.type !== "text_delta") return { notifications: out };
    const text = typeof event.delta.text === "string" ? event.delta.text : "";
    if (text.length === 0) return { notifications: out };
    out.push({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    });
    return { notifications: out };
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
        out.push({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `\n\n[claude error: ${resultText}]` },
            },
          },
        });
      }
      return { notifications: out, stopReason: "refusal" };
    }
    if (subtype === "error_max_turns") {
      return { notifications: out, stopReason: "max_turn_requests" };
    }
    if (subtype === "error_max_tokens") {
      return { notifications: out, stopReason: "max_tokens" };
    }
    return { notifications: out, stopReason: "end_turn" };
  }
  // Other event types (system/init, system/status, tool_result, user
  // mid-turn echo, etc.) — drop silently. Extend as needed.
  return { notifications: out };
}

/**
 * Translate one block from an assistant message's `content` array into
 * ACP notifications. Returns null for blocks we don't surface (notably
 * `text` blocks, which the stream_event deltas already covered).
 *
 * Today we recognise `tool_use` blocks for `AskUserQuestion`: each
 * question becomes a JSON `options` fence so the chat panel renders the
 * choices as clickable buttons. Without this, the question text and
 * options sit inside a `tool_use` frame that the panel never sees, and
 * the model's surrounding prose tends to read like "I have N questions
 * above" with no actual questions or buttons.
 */
function translateAssistantBlock(
  sessionId: string,
  block: unknown,
): AcpUpdateNotification[] | null {
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const b = block as Record<string, unknown>;
  if (b["type"] !== "tool_use") return null;
  if (b["name"] !== "AskUserQuestion") return null;
  const input = b["input"];
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return null;
  const chunks: string[] = [];
  for (const q of questions) {
    const rendered = renderAskUserQuestionItem(q);
    if (rendered) chunks.push(rendered);
  }
  if (chunks.length === 0) return null;
  // Lead with a blank line so the fence parses cleanly even when the
  // model's preceding text didn't end with a newline.
  const text = `\n\n${chunks.join("\n\n")}\n`;
  return [
    {
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    },
  ];
}

function renderAskUserQuestionItem(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const q = raw as Record<string, unknown>;
  const question = typeof q["question"] === "string" ? q["question"].trim() : "";
  if (!question) return null;
  const header = typeof q["header"] === "string" ? q["header"].trim() : "";
  const multiSelect = q["multiSelect"] === true;
  const rawOptions = Array.isArray(q["options"]) ? q["options"] : [];
  const options: { label: string; value: string }[] = [];
  for (const opt of rawOptions) {
    if (!opt || typeof opt !== "object" || Array.isArray(opt)) continue;
    const o = opt as Record<string, unknown>;
    const label = typeof o["label"] === "string" ? o["label"].trim() : "";
    if (!label) continue;
    // Encode the answer with the question header so multi-question
    // turns stay disambiguated when the user's reply lands back in the
    // model's context as plain text.
    const value = header ? `${header}: ${label}` : label;
    options.push({ label, value });
  }
  if (options.length === 0) return null;
  const promptParts = [`**${question}**`];
  if (multiSelect) {
    promptParts.push(
      "_(Multiple answers expected — click one, then type any others.)_",
    );
  } else {
    promptParts.push(
      "_(Pick an option, or type your own answer below.)_",
    );
  }
  const payload = {
    type: "options",
    text: promptParts.join(" "),
    options,
  };
  return "```json\n" + JSON.stringify(payload, null, 2) + "\n```";
}

/**
 * Side-effecting wrapper: applies the pure translator's output to the
 * stdout wire and to the prompt's done() resolver.
 */
function handleClaudeEvent(
  sessionId: string,
  raw: unknown,
  done: (stopReason: ClaudePromptResult["stopReason"]) => void,
): void {
  const { notifications, stopReason } = translateClaudeEvent(sessionId, raw);
  for (const n of notifications) notify(n.method, n.params);
  if (stopReason) done(stopReason);
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
      // replays its own JSONL internally. ACP's mcpServers are bridged
      // to Claude via `--mcp-config <inline-json> --strict-mcp-config`
      // on each turn (see SessionState.mcpServers / runClaudeTurn).
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
  const mcpServers = normalizeMcpServers(params.mcpServers);
  sessions.set(sessionId, {
    cwd: params.cwd ?? process.cwd(),
    resume: false,
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
  });
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
  const mcpServers = normalizeMcpServers(params.mcpServers);
  sessions.set(params.sessionId, {
    cwd: params.cwd ?? process.cwd(),
    resume: true,
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
  });
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
