// Unit tests for the pure handlers inside claude-acp. The real CLI
// surface (stdin loop + spawn of `claude`) is exercised by integration
// smokes; here we only cover the in-process state and protocol shapes.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  handleInitialize,
  handleLoadSession,
  handleNewSession,
  sessions,
  translateClaudeEvent,
} from "../claude-acp.js";

beforeEach(() => sessions.clear());

describe("handleInitialize", () => {
  it("advertises loadSession: true so callers know resume is supported", () => {
    const r = handleInitialize({ protocolVersion: 1 }) as {
      agentCapabilities: { loadSession: boolean };
    };
    assert.equal(r.agentCapabilities.loadSession, true);
  });
});

describe("handleNewSession", () => {
  it("registers a session keyed by the returned sessionId", () => {
    const r = handleNewSession({ cwd: "/tmp" }) as { sessionId: string };
    assert.match(r.sessionId, /^[0-9a-f-]{36}$/);
    assert.ok(sessions.has(r.sessionId));
    assert.equal(sessions.get(r.sessionId)?.cwd, "/tmp");
  });

  it("falls back to process.cwd() when cwd missing", () => {
    const r = handleNewSession({} as { cwd: string }) as { sessionId: string };
    assert.equal(sessions.get(r.sessionId)?.cwd, process.cwd());
  });

  it("starts in non-resume mode so the first turn uses --session-id", () => {
    const r = handleNewSession({ cwd: "/tmp" }) as { sessionId: string };
    assert.equal(sessions.get(r.sessionId)?.resume, false);
  });
});

describe("handleLoadSession", () => {
  it("registers the supplied id (the orchestrator-persisted one) and returns empty", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const r = handleLoadSession({ sessionId: id, cwd: "/wt/branch" });
    assert.deepEqual(r, {});
    assert.ok(sessions.has(id));
    assert.equal(sessions.get(id)?.cwd, "/wt/branch");
  });

  it("marks the session for resume so the next turn uses --resume, not --session-id", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    handleLoadSession({ sessionId: id, cwd: "/wt/branch" });
    assert.equal(sessions.get(id)?.resume, true);
  });

  it("rejects an empty sessionId so callers fail loud, not silently", () => {
    assert.throws(
      () => handleLoadSession({ sessionId: "", cwd: "/x" }),
      /session\/load: sessionId required/,
    );
  });

  it("falls back to process.cwd() when cwd missing", () => {
    const id = "deadbeef-dead-beef-dead-beefdeadbeef";
    handleLoadSession({ sessionId: id } as { sessionId: string; cwd: string });
    assert.equal(sessions.get(id)?.cwd, process.cwd());
  });

  it("idempotent — repeated load with the same id is a no-op overwrite", () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    handleLoadSession({ sessionId: id, cwd: "/first" });
    handleLoadSession({ sessionId: id, cwd: "/second" });
    assert.equal(sessions.size, 1);
    assert.equal(sessions.get(id)?.cwd, "/second");
  });
});

describe("translateClaudeEvent", () => {
  const SID = "00000000-0000-0000-0000-000000000001";

  it("forwards stream_event text_delta as agent_message_chunk", () => {
    const r = translateClaudeEvent(SID, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      },
    });
    assert.equal(r.stopReason, undefined);
    assert.equal(r.notifications.length, 1);
    assert.deepEqual(r.notifications[0], {
      method: "session/update",
      params: {
        sessionId: SID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    });
  });

  it("drops non-text content_block_delta", () => {
    const r = translateClaudeEvent(SID, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
    });
    assert.equal(r.notifications.length, 0);
  });

  it("maps a plain result frame to end_turn with no notifications", () => {
    const r = translateClaudeEvent(SID, {
      type: "result",
      subtype: "success",
      is_error: false,
    });
    assert.equal(r.stopReason, "end_turn");
    assert.equal(r.notifications.length, 0);
  });

  it("maps error_max_turns and error_max_tokens onto their ACP enums", () => {
    assert.equal(
      translateClaudeEvent(SID, { type: "result", subtype: "error_max_turns" })
        .stopReason,
      "max_turn_requests",
    );
    assert.equal(
      translateClaudeEvent(SID, { type: "result", subtype: "error_max_tokens" })
        .stopReason,
      "max_tokens",
    );
  });

  it("surfaces is_error=true result text as a final chunk then refuses", () => {
    const r = translateClaudeEvent(SID, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "rate limited",
    });
    assert.equal(r.stopReason, "refusal");
    assert.equal(r.notifications.length, 1);
    const note = r.notifications[0]!;
    assert.match(
      String((note.params.update as Record<string, unknown>)["content"] &&
        ((note.params.update as Record<string, unknown>)["content"] as
          { text?: string }).text),
      /\[claude error: rate limited\]/,
    );
  });

  it("drops text blocks inside the assistant frame (stream deltas already covered them)", () => {
    const r = translateClaudeEvent(SID, {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "this would have been duplicated" }],
      },
    });
    assert.equal(r.notifications.length, 0);
  });

  it("translates AskUserQuestion tool_use into a JSON options fence per question", () => {
    const r = translateClaudeEvent(SID, {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_abc",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Should NavMeshSystem stay static?",
                  header: "NavMesh",
                  multiSelect: false,
                  options: [
                    { label: "Keep static", description: "Lowest churn" },
                    { label: "Wrap in ISystem", description: "Uniform" },
                  ],
                },
                {
                  question: "How should we reference OneShot?",
                  header: "OneShot",
                  multiSelect: false,
                  options: [
                    { label: "Package", description: "UPM" },
                    { label: "Submodule", description: "Git" },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    assert.equal(r.notifications.length, 1);
    const text = (
      r.notifications[0]!.params.update.content as { text: string }
    ).text;
    // Two question blocks, each a ```json fence.
    const fenceCount = (text.match(/```json/g) ?? []).length;
    assert.equal(fenceCount, 2);
    // Each fence parses as a valid options payload.
    const fences = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)];
    assert.equal(fences.length, 2);
    const first = JSON.parse(fences[0]![1]!);
    assert.equal(first.type, "options");
    assert.equal(first.options.length, 2);
    assert.equal(first.options[0].label, "Keep static");
    // Values are header-prefixed so multi-question replies stay
    // disambiguated when echoed back into the model's context.
    assert.equal(first.options[0].value, "NavMesh: Keep static");
    assert.match(first.text, /Should NavMeshSystem stay static\?/);
    const second = JSON.parse(fences[1]![1]!);
    assert.equal(second.options[1].value, "OneShot: Submodule");
  });

  it("skips questions with no usable options", () => {
    const r = translateClaudeEvent(SID, {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: {
              questions: [
                { question: "no options here", header: "X", options: [] },
                {
                  question: "this one has options",
                  header: "Y",
                  options: [{ label: "Yes" }],
                },
              ],
            },
          },
        ],
      },
    });
    assert.equal(r.notifications.length, 1);
    const text = (
      r.notifications[0]!.params.update.content as { text: string }
    ).text;
    const fences = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)];
    assert.equal(fences.length, 1);
    const parsed = JSON.parse(fences[0]![1]!);
    assert.equal(parsed.options[0].value, "Y: Yes");
  });

  it("does NOT surface tool_use blocks for tools other than AskUserQuestion", () => {
    const r = translateClaudeEvent(SID, {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "ls", description: "list" },
          },
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/x", old_string: "a", new_string: "b" },
          },
        ],
      },
    });
    assert.equal(r.notifications.length, 0);
  });

  it("ignores AskUserQuestion frames whose input shape is malformed", () => {
    for (const bad of [
      { type: "assistant", message: { content: "not an array" } },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "AskUserQuestion" }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "AskUserQuestion", input: null },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "AskUserQuestion",
              input: { questions: "not array" },
            },
          ],
        },
      },
    ]) {
      const r = translateClaudeEvent(SID, bad);
      assert.equal(r.notifications.length, 0, `should drop ${JSON.stringify(bad)}`);
    }
  });

  it("flags multiSelect questions in the rendered prompt text", () => {
    const r = translateClaudeEvent(SID, {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which subsystems to migrate first?",
                  header: "Order",
                  multiSelect: true,
                  options: [{ label: "Input" }, { label: "Camera" }],
                },
              ],
            },
          },
        ],
      },
    });
    const text = (
      r.notifications[0]!.params.update.content as { text: string }
    ).text;
    const fence = text.match(/```json\n([\s\S]*?)\n```/)!;
    const parsed = JSON.parse(fence[1]!);
    assert.match(parsed.text, /Multiple answers expected/);
  });

  it("returns an empty translation for non-object input (defensive)", () => {
    assert.deepEqual(translateClaudeEvent(SID, null), { notifications: [] });
    assert.deepEqual(translateClaudeEvent(SID, [1, 2, 3]), { notifications: [] });
    assert.deepEqual(translateClaudeEvent(SID, "string"), { notifications: [] });
  });
});
