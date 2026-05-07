// Tests for the pure helpers inside acpRunner. The full lifecycle (spawn
// + ACP handshake + MCP host + bridge) is exercised by the smoke harness
// against a real codex-acp binary; here we only cover what's
// deterministically testable in-process.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPromptContent, translateUpdate } from "../acpRunner.js";
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

describe("translateUpdate", () => {
  function capture(update: SessionUpdate): Array<{ stream: string; chunk: string }> {
    const out: Array<{ stream: string; chunk: string }> = [];
    translateUpdate(update, (stream, chunk) => out.push({ stream, chunk }));
    return out;
  }

  it("agent_message_chunk text → stdout chunk verbatim", () => {
    const u: MessageChunkUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    };
    assert.deepEqual(capture(u), [{ stream: "stdout", chunk: "Hello" }]);
  });

  it("agent_thought_chunk text → labeled stdout chunk", () => {
    const u: MessageChunkUpdate = {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking…" },
    };
    assert.deepEqual(capture(u), [{ stream: "stdout", chunk: "[think] thinking…" }]);
  });

  it("user_message_chunk is dropped (chat panel echoes locally)", () => {
    const u: MessageChunkUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "ignore me" },
    };
    assert.deepEqual(capture(u), []);
  });

  it("non-text content blocks are dropped without crashing", () => {
    const u: MessageChunkUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "...", mimeType: "image/png" },
    };
    assert.deepEqual(capture(u), []);
  });

  it("tool_call → stdout line with title + status", () => {
    const u: ToolCallStartUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "opencara_issue_body_set",
      status: "in_progress",
    };
    const out = capture(u);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.stream, "stdout");
    assert.match(out[0]!.chunk, /\[tool\] opencara_issue_body_set \(in_progress\)/);
  });

  it("tool_call_update completed → stdout line with → status", () => {
    const u: ToolCallProgressUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      title: "opencara_issue_body_set",
      status: "completed",
    };
    const out = capture(u);
    assert.equal(out.length, 1);
    assert.match(out[0]!.chunk, /→ completed/);
  });

  it("unmodeled session updates go to stderr", () => {
    const u: SessionUpdate = {
      sessionUpdate: "available_commands_update",
      // extra fields the spec defines for this variant; we don't model them
      availableCommands: [],
    };
    const out = capture(u);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.stream, "stderr");
    assert.match(out[0]!.chunk, /unmodeled update: available_commands_update/);
  });
});
