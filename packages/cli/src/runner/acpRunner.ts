// ACP+MCP runner for one chat job. Replaces `runJob` (the legacy
// stdin-JSON path) when the orchestrator hands the device an
// `AgentSpec` with `.acp` set — see #29 for the chat-route feature flag.
//
// Lifecycle of a single run:
//   1. Construct WsAgentCallBridge (transports tool calls back to the
//      orchestrator via WS) + McpHost (per-run IPC socket).
//   2. Spawn the ACP agent (`spec.command`/`spec.args` — typically
//      `npx @zed-industries/codex-acp`).
//   3. ACP handshake: initialize → session/new (with mcpServers from
//      the host) → session/prompt with the assembled message content.
//   4. Stream `session/update` events through `translateUpdate` so they
//      land on the existing log-frame pipeline. The chat panel SSE tail
//      is unchanged.
//   5. Resolve when the prompt response arrives with `stopReason`.
//   6. Tear down: bridge → host → client. Bounded waits so a misbehaving
//      child doesn't pin the device's event loop.
//
// Session continuity: when `acp.priorSessionId` is set on the spec, the
// runner calls `session/load` to resume the prior conversation. Used by
// the per-(repo, branch) flow loops (issue-implement → pr-review-fix)
// so the agent retains context across iterations on the same worktree.
// First-iteration runs (no prior id) take the `session/new` path. The
// resulting sessionId — fresh or echoed — flows back to the orchestrator
// in the device's `done` frame so it can be persisted for next time.
//
// Chat-route runs without per-(repo, branch) state still pass
// `acp.history` as a prompt-prefix block; that fallback is unchanged.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import type {
  AcpHistoryTurn,
  AgentCallRequest,
  AgentCallResultMessage,
  AgentSpec,
} from "@opencara/shared";
import { AcpClient } from "../acp/client.js";
import {
  ACP_PROTOCOL_VERSION,
  isMessageChunk,
  isToolCallProgress,
  isToolCallStart,
  type ContentBlock,
  type SessionUpdate,
} from "../acp/types.js";
import { McpHost } from "../mcp/host.js";
import { WsAgentCallBridge } from "../mcp/wsBridge.js";

export interface AcpRunHandlers {
  /**
   * Called for each chunk of agent-visible output. Stream "stdout" goes
   * to the existing log-frame pipeline (chat panel SSE); "stderr" is
   * for child-process diagnostics that operators may want to debug.
   */
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Called when the bridge needs to fan out a tool-call to the
   * orchestrator. The caller is the device's WS client; it wraps this
   * in `client.send({ type: "agent-call-request", ... })`.
   */
  sendAgentCall: (req: AgentCallRequest) => void;
}

export interface AcpRunResult {
  /** 0 for `end_turn`, non-zero otherwise. Surfaced to `done` frame. */
  exitCode: number;
  stopReason: string;
  /** ACP sessionId the run executed under. New from `session/new` on
   *  first-iteration runs, echoed from `session/load` on resume.
   *  Surfaced in the device's `done` frame so the orchestrator can
   *  persist it for the next iteration to resume from. Empty string
   *  if the run failed before a session was established. */
  sessionId: string;
}

export interface AcpRunController {
  /**
   * Hand off an inbound `agent-call-result` frame from the WS layer.
   * Routed to the WsAgentCallBridge to resolve the matching pending
   * tool call.
   */
  onAgentCallResult(msg: AgentCallResultMessage): void;
}

export interface RunAcpJobOpts {
  runId: string;
  spec: AgentSpec;
  handlers: AcpRunHandlers;
}

export interface RunAcpJobHandle {
  promise: Promise<AcpRunResult>;
  controller: AcpRunController;
}

/**
 * Start an ACP+MCP job. Returns immediately with a handle whose
 * `promise` resolves when the agent's prompt turn ends. Use
 * `controller.onAgentCallResult` to forward inbound WS frames.
 *
 * Throws synchronously if `spec.acp` is unset — callers must guard.
 */
export function runAcpJob(opts: RunAcpJobOpts): RunAcpJobHandle {
  const { runId, spec, handlers } = opts;
  if (!spec.acp) {
    throw new Error("runAcpJob: spec.acp is required");
  }
  const acpSpec = spec.acp;

  const bridge = new WsAgentCallBridge({
    runId,
    sendRequest: handlers.sendAgentCall,
  });
  const host = new McpHost({ runId, router: bridge.router });

  // Some ACP adapters ship inside this same `opencara` package (e.g.
  // `claude-acp` for the local Claude Code shim). The orchestrator
  // sends a logical command name in `spec.command`; the device resolves
  // it to a concrete invocation here so we don't have to symlink the
  // cli's bin entries into PATH on every device. Unknown commands pass
  // through unchanged (e.g. `npx --yes @zed-industries/codex-acp`).
  const resolved = resolveLocalAcpAdapter(spec.command, spec.args);

  const client = new AcpClient({
    command: resolved.command,
    args: resolved.args,
    env: spec.env,
    cwd: spec.cwd,
  });
  client.onSessionUpdate((p) => translateUpdate(p.update, handlers.onLog));
  client.onStderr((chunk) => handlers.onLog("stderr", chunk));

  const controller: AcpRunController = {
    onAgentCallResult(msg) {
      bridge.onResult(msg);
    },
  };

  const promise = (async (): Promise<AcpRunResult> => {
    let result: AcpRunResult = { exitCode: 1, stopReason: "uninitialized", sessionId: "" };
    try {
      await host.start();
      client.start();

      await client.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      // Resume vs. fresh: the orchestrator sets `priorSessionId` when
      // a prior agent-session.json exists for this (repo, branch) on
      // the pinned device. The shim is responsible for mapping it onto
      // the underlying CLI's resume mechanism (claude-acp passes it
      // straight to `claude --session-id`). On a fresh start we mint
      // a new session and surface the assigned id back up.
      const cwd = spec.cwd ?? process.cwd();
      const mcpServers = [host.acpServerEntry()];
      let sessionId: string;
      if (acpSpec.priorSessionId) {
        await client.loadSession({
          sessionId: acpSpec.priorSessionId,
          cwd,
          mcpServers,
        });
        sessionId = acpSpec.priorSessionId;
      } else {
        const session = await client.newSession({ cwd, mcpServers });
        sessionId = session.sessionId;
      }
      const prompt = buildPromptContent(acpSpec);
      const promptResult = await client.prompt({ sessionId, prompt });
      result = {
        exitCode: promptResult.stopReason === "end_turn" ? 0 : 1,
        stopReason: promptResult.stopReason,
        sessionId,
      };
      return result;
    } finally {
      // Best-effort teardown. Each step bounded so a misbehaving child
      // doesn't pin the event loop. Errors swallowed at the per-promise
      // level — chaining `.catch` on the race itself only silences the
      // arm that resolves, leaving the slow loser as an unhandledRejection
      // when it later throws (PR #33 review finding #1).
      bridge.shutdown("acp run ended");
      await Promise.race([
        host.stop().catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 3000)),
      ]);
      await Promise.race([
        client.close(/* graceMs */ 1000).catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 5000)),
      ]);
    }
  })();

  return { promise, controller };
}

// ─── Internals ──────────────────────────────────────────────────────

/**
 * Stuff system prompt, history, page context, and the user message into
 * one text content block for `session/prompt`. ACP's prompt is a single
 * turn — there's no separate `systemPrompt` channel, and per-turn
 * sessions in #29 mean the agent has no prior memory beyond what we
 * include here. Bracketed section headers help the model parse roles.
 */
export function buildPromptContent(acp: {
  systemPromptMd: string;
  userPromptMd: string;
  history?: AcpHistoryTurn[];
  pageContextJson?: string;
}): ContentBlock[] {
  const parts: string[] = [];
  if (acp.systemPromptMd.trim().length > 0) {
    parts.push(`# System prompt\n\n${acp.systemPromptMd.trim()}`);
  }
  if (acp.pageContextJson && acp.pageContextJson.trim().length > 0) {
    parts.push(`# Page context (JSON)\n\n\`\`\`json\n${acp.pageContextJson}\n\`\`\``);
  }
  const history = acp.history ?? [];
  if (history.length > 0) {
    const turns = history
      .map((t) => `**${t.role}**: ${t.text}`)
      .join("\n\n");
    parts.push(`# Conversation history\n\n${turns}`);
  }
  parts.push(`# Current message\n\n${acp.userPromptMd}`);
  return [{ type: "text", text: parts.join("\n\n---\n\n") }];
}

/**
 * Translate one `session/update` notification onto the existing log-frame
 * shape (stream + text chunk). Conservative — only well-known variants
 * are surfaced; unknown ones are noted on stderr so operators can find
 * them in debug logs without polluting the chat panel.
 */
export function translateUpdate(
  update: SessionUpdate,
  onLog: (stream: "stdout" | "stderr", chunk: string) => void,
): void {
  if (isMessageChunk(update)) {
    if (update.sessionUpdate === "user_message_chunk") {
      // Echo of our own input — the chat panel already shows it.
      return;
    }
    const text = textOfContent(update.content);
    if (!text) return;
    if (update.sessionUpdate === "agent_thought_chunk") {
      // Surface as a labeled prefix so the chat panel can distinguish
      // thinking from final answer. Codex emits these for tool prep.
      onLog("stdout", `[think] ${text}`);
      return;
    }
    // agent_message_chunk
    onLog("stdout", text);
    return;
  }
  if (isToolCallStart(update)) {
    const status = update.status ?? "?";
    onLog("stdout", `\n[tool] ${update.title} (${status})\n`);
    return;
  }
  if (isToolCallProgress(update)) {
    const status = update.status ?? "?";
    const title = update.title ?? "(tool)";
    onLog("stdout", `\n[tool] ${title} → ${status}\n`);
    return;
  }
  // Unknown variant — log to stderr so it shows up in the device
  // console without spamming the user's chat. Likely candidates:
  // available_commands_update, usage_update, plan, current_mode_update.
  onLog("stderr", `[acp] unmodeled update: ${update.sessionUpdate}\n`);
}

function textOfContent(content: ContentBlock): string {
  if (content.type !== "text") return "";
  return content.text ?? "";
}

// ─── Local-adapter resolution ──────────────────────────────────────

/**
 * Bin names that ship inside this package and get resolved to a local
 * path before spawning. Mirrors what `McpHost.defaultMcpInvocation` does
 * for opencara-mcp; centralized here so any future in-package adapter
 * (e.g. an opencode shim) is one entry.
 *
 * Resolution priority per name:
 *   1. Source dev: `tsx <repo>/packages/cli/src/bin/<name>.ts` if the
 *      .ts file exists relative to this module's dir.
 *   2. Bundled: `node <here>/<name>.js` if dist/<name>.js is a sibling
 *      of the bundled bin.js.
 *   3. Fall through: original spec.command/args (relies on PATH).
 */
const LOCAL_ACP_ADAPTERS = new Set(["claude-acp"]);

function resolveLocalAcpAdapter(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (!LOCAL_ACP_ADAPTERS.has(command)) {
    return { command, args: [...args] };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // Source mode: packages/cli/src/runner/acpRunner.ts → ../bin/<name>.ts
  const sourceBin = pathResolve(here, "..", "bin", `${command}.ts`);
  if (existsSync(sourceBin)) {
    return { command: "tsx", args: [sourceBin, ...args] };
  }
  // Bundled mode: dist/bin.js → ./<name>.js (sibling of bundled cli)
  const distBin = pathResolve(here, `${command}.js`);
  if (existsSync(distBin)) {
    return { command: "node", args: [distBin, ...args] };
  }
  // Last resort: rely on PATH (npm i -g opencara puts the bin there).
  return { command, args: [...args] };
}
