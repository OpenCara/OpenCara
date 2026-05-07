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
});
