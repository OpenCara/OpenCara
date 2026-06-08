// Unit tests for the pure scoped-label parser behind agent:/prompt: routing
// (#158). The DB lookups + fail-loud policy live in nodeRunners.ts and are
// exercised by manual smokes; this pins the parsing rules both routers share.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractScopedLabelValues } from "../labelRouting.js";

describe("extractScopedLabelValues", () => {
  it("extracts the value after the prefix", () => {
    assert.deepEqual(
      extractScopedLabelValues(["agent:claude"], "agent:"),
      ["claude"],
    );
  });

  it("ignores labels that don't carry the prefix", () => {
    assert.deepEqual(
      extractScopedLabelValues(
        ["enhancement", "agent:codex", "prompt:fix"],
        "agent:",
      ),
      ["codex"],
    );
  });

  it("trims surrounding whitespace in the value", () => {
    assert.deepEqual(
      extractScopedLabelValues(["agent:  claude  "], "agent:"),
      ["claude"],
    );
  });

  it("drops a bare prefix with no value", () => {
    assert.deepEqual(extractScopedLabelValues(["agent:", "agent:  "], "agent:"), []);
  });

  it("returns every match, preserving order (caller flags 2+ as ambiguous)", () => {
    assert.deepEqual(
      extractScopedLabelValues(["agent:b", "agent:a"], "agent:"),
      ["b", "a"],
    );
  });

  it("returns an empty array when nothing matches", () => {
    assert.deepEqual(extractScopedLabelValues(["bug", "prompt:x"], "agent:"), []);
  });

  it("works the same for the prompt: prefix", () => {
    assert.deepEqual(
      extractScopedLabelValues(
        ["prompt:concise", "agent:claude"],
        "prompt:",
      ),
      ["concise"],
    );
  });

  it("does not treat 'agent:' as a prefix of 'agent-foo'", () => {
    assert.deepEqual(extractScopedLabelValues(["agent-foo"], "agent:"), []);
  });
});
