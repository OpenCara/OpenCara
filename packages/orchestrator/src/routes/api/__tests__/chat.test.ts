// Regex unit tests for the MCP-tool-unavailable detection used to auto-clear
// poisoned ACP sessions. The actual auto-clear path is exercised end-to-end
// by manual smoke (clear session → poison turn → next turn forces session/new),
// but the regexes are the brittle part — sanity-check them here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MCP_POISON_PATTERNS } from "../chat.js";

function matchesAny(text: string): boolean {
  return MCP_POISON_PATTERNS.some((p) => p.test(text));
}

describe("MCP_POISON_PATTERNS", () => {
  it("matches the exact phrasings seen in real failures", () => {
    // Each of these is a verbatim assistant-stdout line that surfaced
    // during the May 2026 debugging sessions. If the model emits any of
    // these on turn N, turn N+1 must NOT resume that session — otherwise
    // the agent re-reads its own confession and refuses to call the tool.
    const samples: string[] = [
      "the `opencara_issue_create` MCP tool isn't available in my current session",
      "the `opencara_issue_body_set` MCP tool isn't available in my current session",
      "The opencara MCP server doesn't appear to be connected to Claude Code",
      "The OpenCara MCP server doesn't appear to be connected",
      "the opencara MCP tools don't appear to be connected to this session",
      "the opencara MCP tools aren't connected",
      "opencara_issue_create MCP tool isn't available",
      "opencara_issue_body_set is not available in my current session",
      "the opencara_issue_create MCP tool isn\u2019t available",
    ];
    for (const s of samples) {
      assert.ok(matchesAny(s), `should match: "${s}"`);
    }
  });

  it("does NOT match benign mentions of MCP or tools", () => {
    // False positives here would unnecessarily trash mid-conversation
    // context. Keep these guards green if patterns are tightened later.
    const safe: string[] = [
      "I'll call the opencara_issue_body_set tool now.",
      "Calling MCP tool: opencara_kanban_wave_dispatch",
      "The MCP server is running and responding normally.",
      "The opencara_issue_create call succeeded.",
      "I'd suggest using the MCP tool here.",
      "the opencara MCP server is connected",
      "MCP server is available",
    ];
    for (const s of safe) {
      assert.ok(!matchesAny(s), `should NOT match: "${s}"`);
    }
  });
});
