// Tests for the pure helpers inside acpRunner. The full lifecycle (spawn
// + ACP handshake + MCP host + bridge) is exercised by the smoke harness
// against a real codex-acp binary; here we only cover what's
// deterministically testable in-process.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptContent,
  createUpdateTranslator,
  matchModelValue,
  selectAcpModel,
} from "../acpRunner.js";
import type { AcpClient } from "../../acp/client.js";
import type { AcpConfigOption } from "../../acp/types.js";
import type {
  MessageChunkUpdate,
  SessionUpdate,
  ToolCallProgressUpdate,
  ToolCallStartUpdate,
} from "../../acp/types.js";

describe("matchModelValue", () => {
  const values = [
    "google/gemini-2.5-flash",
    "volcengine-ark/glm-5.2",
    "minimax/MiniMax-M2.7",
  ];
  it("matches the exact provider/id value", () => {
    assert.equal(matchModelValue("volcengine-ark/glm-5.2", values), "volcengine-ark/glm-5.2");
  });
  it("matches case-insensitively", () => {
    assert.equal(matchModelValue("MINIMAX/minimax-m2.7", values), "minimax/MiniMax-M2.7");
  });
  it("matches a bare model id by provider-qualified suffix", () => {
    assert.equal(matchModelValue("glm-5.2", values), "volcengine-ark/glm-5.2");
  });
  it("returns undefined when nothing matches", () => {
    assert.equal(matchModelValue("nope/model-x", values), undefined);
  });
  it("returns undefined for empty input", () => {
    assert.equal(matchModelValue("  ", values), undefined);
  });
});

describe("selectAcpModel", () => {
  const modelOption = (values: string[], current?: string): AcpConfigOption[] => [
    {
      type: "select",
      id: "model",
      category: "model",
      currentValue: current,
      options: values.map((value) => ({ value })),
    },
  ];
  const fakeClient = (impl: (req: unknown) => Promise<unknown>) => {
    const calls: unknown[] = [];
    const client = {
      setConfigOption: (req: unknown) => {
        calls.push(req);
        return impl(req);
      },
    } as unknown as AcpClient;
    return { client, calls };
  };
  const collectLogs = () => {
    const lines: string[] = [];
    return { lines, sink: (_s: string, chunk: string) => void lines.push(chunk) };
  };

  it("stays silent when the advertised currentValue already matches (claude argv path)", async () => {
    const { client, calls } = fakeClient(async () => ({}));
    const { lines, sink } = collectLogs();
    await selectAcpModel(
      client,
      "s1",
      "claude-sonnet-5",
      modelOption(["claude-sonnet-5"], "claude-sonnet-5"),
      sink,
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(lines, []);
  });

  it("attempts a freeform set when no advertised value matches, and reports success", async () => {
    const { client, calls } = fakeClient(async () => ({}));
    const { lines, sink } = collectLogs();
    await selectAcpModel(client, "s1", "claude-fable-5", modelOption(["claude-sonnet-5"]), sink);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { sessionId: "s1", configId: "model", value: "claude-fable-5" });
    assert.ok(lines.some((l) => l.includes("selected model claude-fable-5 (freeform)")));
  });

  it("falls back to the default message when the freeform attempt is rejected", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("Model not found");
    });
    const { lines, sink } = collectLogs();
    await selectAcpModel(client, "s1", "nope-1", modelOption(["claude-sonnet-5"]), sink);
    assert.ok(lines.some((l) => l.includes('not among available models')));
  });

  it("still logs the no-option note when the agent advertises nothing", async () => {
    const { client, calls } = fakeClient(async () => ({}));
    const { lines, sink } = collectLogs();
    await selectAcpModel(client, "s1", "claude-sonnet-5", undefined, sink);
    assert.equal(calls.length, 0);
    assert.ok(lines.some((l) => l.includes("advertised no model option")));
  });
});

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

  it("appends one image block per attachment after the text block (#142)", () => {
    const blocks = buildPromptContent({
      systemPromptMd: "sys",
      userPromptMd: "look at these",
      images: [
        { data: "AAAA", mimeType: "image/png" },
        { data: "BBBB", mimeType: "image/jpeg" },
      ],
    });
    assert.equal(blocks.length, 3);
    // Text first so the model reads instructions before attachments.
    assert.equal(blocks[0]!.type, "text");
    assert.deepEqual(blocks[1], {
      type: "image",
      data: "AAAA",
      mimeType: "image/png",
    });
    assert.deepEqual(blocks[2], {
      type: "image",
      data: "BBBB",
      mimeType: "image/jpeg",
    });
  });

  it("produces only the text block when no images are attached", () => {
    const blocks = buildPromptContent({
      systemPromptMd: "sys",
      userPromptMd: "hi",
      images: [],
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.type, "text");
  });
});

describe("createUpdateTranslator", () => {
  function runSeq(
    updates: SessionUpdate[],
    opts: { flush?: boolean; captureThinking?: boolean } = {},
  ): Array<{ stream: string; chunk: string }> {
    const out: Array<{ stream: string; chunk: string }> = [];
    const t = createUpdateTranslator(
      (stream, chunk) => out.push({ stream, chunk }),
      { captureThinking: opts.captureThinking },
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
    // The start line names the tool and stops there — status at start is
    // always pending/in_progress, so it never carried information.
    assert.match(out[3]!.chunk, /\[tool\] opencara_issue_body_set/);
    assert.equal(out[3]!.chunk.includes("in_progress"), false);
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

  describe("captureThinking: false", () => {
    const thought = (text: string): MessageChunkUpdate => ({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    });

    it("drops thought chunks entirely — no text and no empty fence", () => {
      // An empty [think]/[/think] pair would still render as a thinking
      // block in the chat panel, so the fence must not open either.
      assert.deepEqual(
        runSeq([thought("secret reasoning")], {
          flush: true,
          captureThinking: false,
        }),
        [],
      );
    });

    it("leaves real output untouched between dropped thoughts", () => {
      const updates: SessionUpdate[] = [
        thought("first"),
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } },
        thought("second"),
      ];
      assert.deepEqual(runSeq(updates, { flush: true, captureThinking: false }), [
        { stream: "stdout", chunk: "Answer" },
      ]);
    });

    it("flush after a dropped thought emits no stray [/think]", () => {
      // The fence state machine is never entered, so there is nothing to
      // close — a stray closer would corrupt the chat panel's parse.
      const out = runSeq([thought("x")], { flush: true, captureThinking: false });
      assert.equal(
        out.some((o) => o.chunk.includes("[/think]")),
        false,
      );
    });

    it("captures by default and when explicitly true (absent field = capture)", () => {
      for (const captureThinking of [undefined, true]) {
        const out = runSeq([thought("visible")], { flush: true, captureThinking });
        assert.deepEqual(out, [
          { stream: "stdout", chunk: "\n[think]\n" },
          { stream: "stdout", chunk: "visible" },
          { stream: "stdout", chunk: "\n[/think]\n" },
        ]);
      }
    });
  });


  describe("tool call lines", () => {
    const start = (id: string, title: string): ToolCallStartUpdate => ({
      sessionUpdate: "tool_call",
      toolCallId: id,
      title,
      status: "pending",
    });
    const upd = (
      id: string,
      status: ToolCallProgressUpdate["status"],
      title?: string,
    ): ToolCallProgressUpdate => ({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      status,
      ...(title === undefined ? {} : { title }),
    });

    it("resolves the title by toolCallId when the update omits it", () => {
      // The regression: ACP updates carry only changed fields, so `title` is
      // absent on nearly all of them. Reading update.title directly printed
      // the literal "(tool)".
      const out = runSeq([start("tc1", "Read File"), upd("tc1", "completed")]);
      assert.deepEqual(out.map((o) => o.chunk), [
        "\n[tool] Read File\n",
        "\n[tool] Read File → completed\n",
      ]);
      assert.equal(
        out.some((o) => o.chunk.includes("(tool)")),
        false,
      );
    });

    it("says nothing on non-terminal transitions", () => {
      // 64 `→ in_progress` lines in one real run, none of them news.
      const out = runSeq([
        start("tc1", "Find"),
        upd("tc1", "pending"),
        upd("tc1", "in_progress"),
        upd("tc1", "in_progress"),
      ]);
      assert.deepEqual(out.map((o) => o.chunk), ["\n[tool] Find\n"]);
    });

    it("a later title refines the one used on the closing line", () => {
      const out = runSeq([
        start("tc1", "Read File"),
        upd("tc1", "in_progress", "Read /abs/path.md"),
        upd("tc1", "completed"),
      ]);
      assert.deepEqual(out.map((o) => o.chunk), [
        "\n[tool] Read File\n",
        "\n[tool] Read /abs/path.md → completed\n",
      ]);
    });

    it("reports a failure rather than swallowing it", () => {
      const out = runSeq([start("tc1", "grep"), upd("tc1", "failed")]);
      assert.equal(out.at(-1)!.chunk, "\n[tool] grep → failed\n");
    });

    it("keeps concurrent calls' titles apart", () => {
      const out = runSeq([
        start("a", "Web Search"),
        start("b", "Read File"),
        upd("b", "completed"),
        upd("a", "completed"),
      ]);
      assert.deepEqual(out.map((o) => o.chunk).slice(2), [
        "\n[tool] Read File → completed\n",
        "\n[tool] Web Search → completed\n",
      ]);
    });

    it("falls back to (tool) only when the id was never introduced", () => {
      // An update for a call whose `tool_call` start we never saw — the one
      // case where there is genuinely no name to print.
      const out = runSeq([upd("ghost", "completed")]);
      assert.deepEqual(out.map((o) => o.chunk), ["\n[tool] (tool) → completed\n"]);
    });
  });

});
