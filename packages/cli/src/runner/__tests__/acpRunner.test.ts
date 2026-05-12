// Tests for the pure helpers inside acpRunner. The full lifecycle (spawn
// + ACP handshake + MCP host + bridge) is exercised by the smoke harness
// against a real codex-acp binary; here we only cover what's
// deterministically testable in-process.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPromptContent, createUpdateTranslator } from "../acpRunner.js";
import type {
  MessageChunkUpdate,
  SessionUpdate,
  ToolCallProgressUpdate,
  ToolCallStartUpdate,
} from "../../acp/types.js";

describe("buildPromptContent", () => {
  it("assembles all sections in the expected order", () => {
    const blocks = buildPromptContent({
      systemPromptMd: "You are a helper.",
      userPromptMd: "What's on this page?",
      history: [
        { role: "user", text: "earlier user msg" },
        { role: "assistant", text: "earlier reply" },
      ],
      pageContextJson: '{"page":"issue-canvas","projectId":"p1"}',
    });
    assert.equal(blocks.length, 1);
    const block = blocks[0]!;
    assert.equal(block.type, "text");
    if (block.type !== "text") return;
    // Sections appear in order; each separated by `---`.
    const idxSys = block.text.indexOf("# System prompt");
    const idxCtx = block.text.indexOf("# Page context");
    const idxHist = block.text.indexOf("# Conversation history");
    const idxNow = block.text.indexOf("# Current message");
    assert.ok(idxSys >= 0 && idxSys < idxCtx);
    assert.ok(idxCtx < idxHist);
    assert.ok(idxHist < idxNow);
    assert.match(block.text, /\*\*user\*\*: earlier user msg/);
    assert.match(block.text, /\*\*assistant\*\*: earlier reply/);
    assert.match(block.text, /What's on this page\?/);
  });

  it("omits empty sections (no system, no history, no page context)", () => {
    const blocks = buildPromptContent({
      systemPromptMd: "   ",
      userPromptMd: "hi",
      history: [],
    });
    assert.equal(blocks.length, 1);
    const t = blocks[0]!.type === "text" ? blocks[0]!.text : "";
    assert.equal(t.includes("# System prompt"), false);
    assert.equal(t.includes("# Page context"), false);
    assert.equal(t.includes("# Conversation history"), false);
    assert.match(t, /# Current message[\s\S]*hi/);
  });
});

describe("createUpdateTranslator", () => {
  function runSeq(
    updates: SessionUpdate[],
    opts: { flush?: boolean } = {},
  ): Array<{ stream: string; chunk: string }> {
    const out: Array<{ stream: string; chunk: string }> = [];
    const t = createUpdateTranslator((stream, chunk) =>
      out.push({ stream, chunk }),
    );
    for (const u of updates) t.handle(u);
    if (opts.flush) t.flush();
    return out;
  }

  it("agent_message_chunk text → stdout chunk verbatim", () => {
    const u: MessageChunkUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    };
    assert.deepEqual(runSeq([u]), [{ stream: "stdout", chunk: "Hello" }]);
  });

  it("single agent_thought_chunk → opens fence, text, closes on flush", () => {
    const u: MessageChunkUpdate = {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking…" },
    };
    assert.deepEqual(runSeq([u], { flush: true }), [
      { stream: "stdout", chunk: "\n[think]\n" },
      { stream: "stdout", chunk: "thinking…" },
      { stream: "stdout", chunk: "\n[/think]\n" },
    ]);
  });

  it("consecutive thought deltas share one fence (no per-token [think])", () => {
    // Reproduces the opencode symptom: stream of token deltas labeled as
    // agent_thought_chunk. Before the fix the chat saw
    // "[think] I[think]  need[think]  to…"; after, one fenced block.
    const deltas = ["I", " need", " to", " think"].map(
      (text): MessageChunkUpdate => ({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      }),
    );
    assert.deepEqual(runSeq(deltas, { flush: true }), [
      { stream: "stdout", chunk: "\n[think]\n" },
      { stream: "stdout", chunk: "I" },
      { stream: "stdout", chunk: " need" },
      { stream: "stdout", chunk: " to" },
      { stream: "stdout", chunk: " think" },
      { stream: "stdout", chunk: "\n[/think]\n" },
    ]);
  });

  it("thought → message transition emits [/think] before the message", () => {
    const seq: SessionUpdate[] = [
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "ponder" },
      } satisfies MessageChunkUpdate,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "answer" },
      } satisfies MessageChunkUpdate,
    ];
    assert.deepEqual(runSeq(seq), [
      { stream: "stdout", chunk: "\n[think]\n" },
      { stream: "stdout", chunk: "ponder" },
      { stream: "stdout", chunk: "\n[/think]\n" },
      { stream: "stdout", chunk: "answer" },
    ]);
  });

  it("message-only stream emits no fence at all", () => {
    const seq: MessageChunkUpdate[] = ["hi", " there"].map((text) => ({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    }));
    assert.deepEqual(runSeq(seq, { flush: true }), [
      { stream: "stdout", chunk: "hi" },
      { stream: "stdout", chunk: " there" },
    ]);
  });

  it("tool_call during a thought block closes the fence first", () => {
    const seq: SessionUpdate[] = [
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "deciding" },
      } satisfies MessageChunkUpdate,
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "opencara_issue_body_set",
        status: "in_progress",
      } satisfies ToolCallStartUpdate,
    ];
    const out = runSeq(seq);
    assert.deepEqual(out.slice(0, 3), [
      { stream: "stdout", chunk: "\n[think]\n" },
      { stream: "stdout", chunk: "deciding" },
      { stream: "stdout", chunk: "\n[/think]\n" },
    ]);
    assert.equal(out[3]!.stream, "stdout");
    assert.match(out[3]!.chunk, /\[tool\] opencara_issue_body_set \(in_progress\)/);
  });

  it("user_message_chunk is dropped and doesn't disturb fence state", () => {
    const seq: MessageChunkUpdate[] = [
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "a" },
      },
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "ignore me" },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "b" },
      },
    ];
    // Fence should open once, swallow both thought deltas with the
    // user echo in between, and stay open (no flush in this case).
    assert.deepEqual(runSeq(seq), [
      { stream: "stdout", chunk: "\n[think]\n" },
      { stream: "stdout", chunk: "a" },
      { stream: "stdout", chunk: "b" },
    ]);
  });

  it("non-text content blocks are dropped without crashing", () => {
    const u: MessageChunkUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "...", mimeType: "image/png" },
    };
    assert.deepEqual(runSeq([u]), []);
  });

  it("tool_call_update completed → stdout line with → status", () => {
    const u: ToolCallProgressUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      title: "opencara_issue_body_set",
      status: "completed",
    };
    const out = runSeq([u]);
    assert.equal(out.length, 1);
    assert.match(out[0]!.chunk, /→ completed/);
  });

  it("unmodeled session updates go to stderr and don't close an open fence", () => {
    const seq: SessionUpdate[] = [
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "x" },
      } satisfies MessageChunkUpdate,
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      },
    ];
    const out = runSeq(seq);
    assert.deepEqual(out, [
      { stream: "stdout", chunk: "\n[think]\n" },
      { stream: "stdout", chunk: "x" },
      { stream: "stderr", chunk: "[acp] unmodeled update: available_commands_update\n" },
    ]);
  });

  it("flush() on a stream that never entered a fence is a no-op", () => {
    assert.deepEqual(runSeq([], { flush: true }), []);
  });
});
