import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { createEventTranslator } from "../markers.js";

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string };

const assistant = (...content: Block[]) =>
  ({ role: "assistant", content }) as unknown as Message;
const start = (): AgentEvent => ({ type: "message_start", message: assistant() });
const end = (...content: Block[]) =>
  ({ type: "message_end", entry: { model: [assistant(...content)] } }) as unknown as AgentEvent;
const delta = (kind: "text_delta" | "thinking_delta", text: string, contentIndex = 0) =>
  ({ type: "message_update", changes: [{ type: kind, contentIndex, delta: text }] }) as unknown as AgentEvent;
const toolStart = (toolName: string, args: Record<string, unknown>, extra = {}) =>
  ({ type: "tool_execution_start", toolCallId: "t1", toolName, args, ...extra }) as unknown as AgentEvent;
const toolEnd = (extra: Record<string, unknown>) =>
  ({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", ...extra }) as unknown as AgentEvent;

function translate(events: AgentEvent[], opts: { captureThinking?: boolean } = {}) {
  let stdout = "";
  const t = createEventTranslator((stream, chunk) => {
    if (stream === "stdout") stdout += chunk;
  }, opts);
  for (const e of events) t.handle(e);
  t.flush();
  return { stdout, sawText: t.sawText };
}

describe("createEventTranslator", () => {
  it("prints streamed text once even though message_end carries it again", () => {
    const { stdout } = translate([
      start(),
      delta("text_delta", "Hel"),
      delta("text_delta", "lo"),
      end({ type: "text", text: "Hello, world" }),
    ]);
    assert.equal(stdout, "Hello, world");
  });

  it("prints a reply that arrived without deltas from message_end", () => {
    assert.equal(translate([start(), end({ type: "text", text: "Done." })]).stdout, "Done.");
  });

  it("fences reasoning and closes the fence before the reply", () => {
    const { stdout } = translate([
      start(),
      delta("thinking_delta", "plan"),
      delta("text_delta", "ok", 1),
      end({ type: "thinking", thinking: "plan" }, { type: "text", text: "ok" }),
    ]);
    assert.equal(stdout, "\n[think]\nplan\n[/think]\nok");
  });

  it("closes a fence left open when the run ends mid-thought", () => {
    assert.equal(translate([start(), delta("thinking_delta", "hmm")]).stdout, "\n[think]\nhmm\n[/think]\n");
  });

  it("prints a batch in message order when a new block lands ahead of the reasoning before it", () => {
    const { stdout } = translate([
      start(),
      delta("thinking_delta", 'exactly "pong'),
      {
        type: "message_update",
        changes: [
          { type: "text_start", contentIndex: 1, block: { type: "text", text: "p" } },
          { type: "thinking_delta", contentIndex: 0, delta: '".' },
        ],
      } as unknown as AgentEvent,
      delta("text_delta", "ong", 1),
      end({ type: "thinking", thinking: 'exactly "pong".' }, { type: "text", text: "pong" }),
    ]);
    assert.equal(stdout, '\n[think]\nexactly "pong".\n[/think]\npong');
  });

  it("drops reasoning entirely, fences included, when capture is off", () => {
    const { stdout } = translate(
      [start(), delta("thinking_delta", "secret"), end({ type: "thinking", thinking: "secret" }, { type: "text", text: "ok" })],
      { captureThinking: false },
    );
    assert.equal(stdout, "ok");
  });

  it("separates the text of consecutive assistant messages", () => {
    const { stdout } = translate([
      start(),
      end({ type: "text", text: "one" }),
      start(),
      end({ type: "text", text: "two" }),
    ]);
    assert.equal(stdout, "one\n\ntwo");
  });

  it("frames a tool call as one-line start and end markers", () => {
    const { stdout } = translate([
      toolStart("bash", { command: "cat <<EOF\nmulti line\nEOF" }),
      toolEnd({ entry: { model: [{ role: "toolResult", isError: false }] } }),
    ]);
    assert.equal(
      stdout,
      "\n[tool] bash: cat <<EOF multi line EOF\n\n[tool] bash: cat <<EOF multi line EOF → completed\n",
    );
  });

  it("marks errored and result-less tool calls failed", () => {
    for (const end_ of [
      toolEnd({ entry: { model: [{ role: "toolResult", isError: true }] } }),
      toolEnd({}),
    ]) {
      const { stdout } = translate([toolStart("read", { path: "a.md" }), end_]);
      assert.match(stdout, /\[tool\] read a\.md → failed\n$/);
    }
  });

  it("leaves nested tool calls out of the log", () => {
    const { stdout } = translate([toolStart("bash", { command: "ls" }, { parentToolCallId: "p" })]);
    assert.equal(stdout, "");
  });

  it("counts only non-blank text as a reply", () => {
    assert.equal(translate([start(), end({ type: "text", text: " \n" })]).sawText, false);
    assert.equal(translate([start(), end({ type: "text", text: "yes" })]).sawText, true);
  });
});
