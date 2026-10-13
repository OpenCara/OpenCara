// Translates a durable conversation's agent events into the log stream the
// orchestrator and the chat panel read (grammar parsed by `agent-markers.ts`
// in @opencara/shared):
//
//   \n[think]\n … \n[/think]\n     reasoning, dropped entirely when the agent
//                                  has captureThinking off
//   \n[tool] <title>\n             a tool call starting
//   \n[tool] <title> → <status>\n  that call finishing (completed | failed)
//   anything else on stdout        the assistant's text, verbatim
//
// Text reaches the event stream two ways: as deltas while the provider
// streams (committed at most every progress interval), and whole in the
// message's `message_end` entry. A fast response skips the deltas entirely,
// so the translator remembers how much of each content block it printed and
// prints only the rest — never twice, never lost.

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { AgentEvent, JsonObject } from "@earendil-works/pi-durable";

export type LogSink = (stream: "stdout" | "stderr", chunk: string) => void;

export interface EventTranslator {
  handle(event: AgentEvent): void;
  /** Close a thought fence left open; call once the run ended, however it ended. */
  flush(): void;
  /** Whether any non-blank assistant text reached stdout. */
  readonly sawText: boolean;
}

type Block = AssistantMessage["content"][number];

export function createEventTranslator(
  onLog: LogSink,
  opts: { captureThinking?: boolean } = {},
): EventTranslator {
  // Absent = capture, matching the wire default.
  const captureThinking = opts.captureThinking !== false;
  let inThought = false;
  let sawText = false;
  let lastChar = "";
  // Characters already printed per content block of the in-flight assistant
  // message, and whether that message printed text yet (for separation).
  let printed = new Map<number, number>();
  let messageText = false;
  // toolCallId → title printed at the call's start, reused for its end line.
  const toolTitles = new Map<string, string>();

  const stdout = (chunk: string) => {
    onLog("stdout", chunk);
    lastChar = chunk.at(-1) ?? lastChar;
  };
  const leaveThought = () => {
    if (!inThought) return;
    stdout("\n[/think]\n");
    inThought = false;
  };

  const print = (index: number, kind: "text" | "thinking", delta: string) => {
    printed.set(index, (printed.get(index) ?? 0) + delta.length);
    if (delta.length === 0) return;
    if (kind === "thinking") {
      // Dropped at the source: no fence either, or an empty [think] pair
      // would render as a thinking block with nothing in it.
      if (!captureThinking) return;
      if (!inThought) {
        stdout("\n[think]\n");
        inThought = true;
      }
      stdout(delta);
      return;
    }
    leaveThought();
    // Two assistant messages with no tool call between them (a retry, a
    // continued run) would otherwise run their text together.
    if (!messageText && lastChar !== "" && lastChar !== "\n") stdout("\n\n");
    messageText = true;
    stdout(delta);
    if (delta.trim().length > 0) sawText = true;
  };
  const catchUpBlock = (index: number, block: Block) => {
    if (block.type === "text") print(index, "text", block.text.slice(printed.get(index) ?? 0));
    else if (block.type === "thinking") {
      print(index, "thinking", block.thinking.slice(printed.get(index) ?? 0));
    }
  };
  const catchUpMessage = (message: Message) => {
    if (message.role !== "assistant") return;
    message.content.forEach((block, index) => catchUpBlock(index, block));
  };

  return {
    handle(event) {
      switch (event.type) {
        case "message_start":
          if (event.message.role !== "assistant") return;
          printed = new Map();
          messageText = false;
          catchUpMessage(event.message);
          return;
        case "message_update":
          for (const change of event.changes) {
            if (change.type === "text_delta") print(change.contentIndex, "text", change.delta);
            else if (change.type === "thinking_delta") {
              print(change.contentIndex, "thinking", change.delta);
            } else if (
              change.type === "text_start" ||
              change.type === "thinking_start" ||
              change.type === "block"
            ) {
              catchUpBlock(change.contentIndex, change.block);
            } else if (change.type === "message") catchUpMessage(change.message);
            // Tool-call blocks print when the call runs (tool_execution_*).
          }
          return;
        case "message_end":
          for (const message of event.entry.model ?? []) catchUpMessage(message);
          printed = new Map();
          messageText = false;
          return;
        case "tool_execution_start": {
          // Nested calls (a tool calling tools) belong to their caller's line.
          if (event.parentToolCallId !== undefined) return;
          leaveThought();
          const title = flattenToolTitle(toolTitle(event.toolName, event.args));
          toolTitles.set(event.toolCallId, title);
          stdout(`\n[tool] ${title}\n`);
          return;
        }
        case "tool_execution_end": {
          if (event.parentToolCallId !== undefined) return;
          leaveThought();
          const title = toolTitles.get(event.toolCallId) ?? flattenToolTitle(event.toolName);
          toolTitles.delete(event.toolCallId);
          // No result at all = the tool task faulted or was orphaned.
          const result = event.entry?.model?.find((m) => m.role === "toolResult");
          const failed = result ? result.isError : (event.result?.isError ?? true);
          stdout(`\n[tool] ${title} → ${failed ? "failed" : "completed"}\n`);
          return;
        }
        case "auto_retry_start":
          onLog("stderr", `[pi] request failed, retry ${event.attempt}: ${event.errorMessage}\n`);
          return;
        case "task_failed":
          onLog("stderr", `[pi] ${event.kind} task failed: ${event.message}\n`);
          return;
        case "compaction_start":
          onLog("stderr", `[pi] compacting the conversation (${event.reason})\n`);
          return;
        case "compaction_end":
          if (event.error) onLog("stderr", `[pi] compaction failed: ${event.error}\n`);
          return;
        case "snapshot":
          // Only sent when this listener fell >100 commits behind: the
          // skipped deltas are gone, the message_end entries still arrive.
          onLog("stderr", "[pi] event stream fell behind; some streamed output is missing\n");
          return;
        default:
          return;
      }
    },
    flush() {
      leaveThought();
    },
    get sawText() {
      return sawText;
    },
  };
}

/** One identifying line per call: the shell command, the file path, or the
 *  arguments of anything else. */
function toolTitle(name: string, args: JsonObject): string {
  const command = args["command"];
  const path = args["path"];
  if (name === "bash" && typeof command === "string") return `bash: ${command}`;
  if (typeof path === "string" && (name === "read" || name === "write" || name === "edit")) {
    return `${name} ${path}`;
  }
  return Object.keys(args).length > 0 ? `${name} ${JSON.stringify(args)}` : name;
}

/**
 * A `[tool]` marker must stay ONE line: the stripper removes whole marker
 * lines, so a multi-line title (a heredoc in a bash command, a GraphQL
 * query) would leave its tail in a posted review body. Whitespace runs
 * collapse to one space, and the result is capped — the line identifies a
 * call, it doesn't archive it.
 */
const TOOL_TITLE_MAX = 200;

export function flattenToolTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "(tool)";
  return flat.length > TOOL_TITLE_MAX ? `${flat.slice(0, TOOL_TITLE_MAX - 1)}…` : flat;
}
