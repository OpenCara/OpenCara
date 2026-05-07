import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAgentResultText } from "../output.js";

describe("extractAgentResultText", () => {
  it("extracts .result from claude --output-format json envelope", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 56180,
      duration_api_ms: 55788,
      num_turns: 1,
      result: "## Verdict\nCOMMENT\n\n## Summary\n…",
      stop_reason: "end_turn",
      session_id: "c88fa6e8",
      total_cost_usd: 0.58,
    });
    assert.equal(
      extractAgentResultText(raw),
      "## Verdict\nCOMMENT\n\n## Summary\n…",
    );
  });

  it("returns input verbatim when not a JSON object", () => {
    const raw = "## Plain markdown review\n\nLooks good to me.";
    assert.equal(extractAgentResultText(raw), raw);
  });

  it("returns input verbatim when JSON object lacks .result string", () => {
    const raw = JSON.stringify({ type: "session_meta", id: "abc" });
    assert.equal(extractAgentResultText(raw), raw);
  });

  it("returns input verbatim when .result is non-string", () => {
    const raw = JSON.stringify({ type: "result", result: { nested: "no" } });
    assert.equal(extractAgentResultText(raw), raw);
  });

  it("returns input verbatim when JSON parse fails", () => {
    const raw = "{ not valid json";
    assert.equal(extractAgentResultText(raw), raw);
  });

  it("does not mistake JSONL streams for a single envelope", () => {
    // First line is a complete object; second line would parse separately.
    // Whole string isn't valid JSON → fall through to verbatim.
    const raw =
      `{"type":"session_meta","id":"x"}\n` +
      `{"type":"item.completed","item":{"item_type":"agent_message","text":"hi"}}\n`;
    assert.equal(extractAgentResultText(raw), raw);
  });

  it("preserves leading/trailing whitespace in extracted result", () => {
    // The wrapper trims for the JSON parse but the extracted .result is
    // returned verbatim — the caller (action runner) trims again before
    // posting, but other consumers may want the raw text.
    const raw = JSON.stringify({
      type: "result",
      result: "  spaced result  ",
    });
    assert.equal(extractAgentResultText(raw), "  spaced result  ");
  });

  it("returns empty string for empty input", () => {
    assert.equal(extractAgentResultText(""), "");
    assert.equal(extractAgentResultText("   "), "");
  });

  it("does NOT unwrap envelopes with is_error: true", () => {
    // When Claude exits with an error, `.result` is the partial/error
    // text — posting it as a clean review body would hide the failure.
    // Falling through to verbatim keeps the envelope (with `is_error`,
    // `subtype`, `duration_ms`) visible to operators.
    const raw = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      duration_ms: 32100,
      result: "I ran out of tool calls before finishing the review.",
    });
    assert.equal(extractAgentResultText(raw), raw);
  });

  it("unwraps when is_error is explicitly false (the canonical success shape)", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "## Verdict\nCOMMENT",
    });
    assert.equal(extractAgentResultText(raw), "## Verdict\nCOMMENT");
  });

  // ─── codex --json (JSONL) ─────────────────────────────────────────

  it("extracts agent_message from codex JSONL stream, dropping reasoning + commands", () => {
    // Real-world shape from codex@latest. Without filtering, this would
    // pass through as 1MB+ of tool-use traces and overflow downstream
    // synthesizer context (opencara.com flow-run 01KR1CE7AYPHE8VKFA0N7H7ETE).
    const raw = [
      '{"type":"thread.started","thread_id":"019e02c7-2a3e-7203-9bc6-60d10e9ff3c8"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Evaluating code review process** ... lots of chain-of-thought text ..."}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"## Verdict\\n\\nCOMMENT\\n\\n## Summary\\n\\nThe diff replaces -a never with the new flag."}}',
      '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"git diff main...HEAD","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"git diff main...HEAD","aggregated_output":"... 200KB of diff ...","exit_code":0,"status":"completed"}}',
      '{"type":"turn.completed"}',
      "",
    ].join("\n");
    assert.equal(
      extractAgentResultText(raw),
      "## Verdict\n\nCOMMENT\n\n## Summary\n\nThe diff replaces -a never with the new flag.",
    );
  });

  it("concatenates multiple agent_message frames from a single codex run", () => {
    const raw = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"first thought"}}',
      '{"type":"item.completed","item":{"id":"i2","type":"reasoning","text":"middle reasoning"}}',
      '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"second thought"}}',
      '{"type":"turn.completed"}',
      "",
    ].join("\n");
    assert.equal(extractAgentResultText(raw), "first thought\n\nsecond thought");
  });

  it("falls through to verbatim when codex run produced no agent_message frames", () => {
    // Agent crashed mid-reasoning before emitting an answer. We don't
    // want to silently swallow the failure — return raw so operators
    // can see what went wrong.
    const raw = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"item.completed","item":{"id":"i1","type":"reasoning","text":"thinking..."}}',
      '{"type":"turn.aborted","reason":"out_of_context"}',
      "",
    ].join("\n");
    assert.equal(extractAgentResultText(raw), raw);
  });

  it("is idempotent on already-extracted text (safe to apply twice)", () => {
    // engine.ts extracts before storing in `outputs`; nodeRunners.ts's
    // actionRunner also extracts before posting to GitHub. Both layers
    // calling extract is fine — plain markdown falls through verbatim.
    const clean = "## Verdict\n\nCOMMENT\n\nLooks good.";
    assert.equal(extractAgentResultText(clean), clean);
    assert.equal(extractAgentResultText(extractAgentResultText(clean)), clean);
  });
});
