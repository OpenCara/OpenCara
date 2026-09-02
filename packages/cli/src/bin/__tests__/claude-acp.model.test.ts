// Model config-option surface of claude-acp: argv model parsing, the
// session/new + session/load advertisement, and session/set_config_option.
// This is what silences the runner's misleading
//   [acp] model "…" requested but the agent advertised no model option
// for claude agents whose model IS applied via the argv `--model` extra.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AcpConfigOption } from "../../acp/types.js";
import {
  _setExtraClaudeArgsForTest,
  handleLoadSession,
  handleNewSession,
  handleSetConfigOption,
  parseModelFromArgs,
  sessions,
  thoughtLevelConfigOption,
} from "../claude-acp.js";

beforeEach(() => sessions.clear());
afterEach(() => _setExtraClaudeArgsForTest([]));

describe("parseModelFromArgs", () => {
  it("recognises --model <v>, --model=<v>, -m <v>, -m=<v>", () => {
    assert.equal(parseModelFromArgs(["--model", "claude-sonnet-5"]), "claude-sonnet-5");
    assert.equal(parseModelFromArgs(["--model=claude-sonnet-5"]), "claude-sonnet-5");
    assert.equal(parseModelFromArgs(["-m", "claude-sonnet-5"]), "claude-sonnet-5");
    assert.equal(parseModelFromArgs(["-m=claude-sonnet-5"]), "claude-sonnet-5");
  });

  it("last occurrence wins (claude CLI last-flag-wins semantics)", () => {
    assert.equal(
      parseModelFromArgs(["--model", "claude-opus-4-5", "--model", "claude-sonnet-5"]),
      "claude-sonnet-5",
    );
  });

  it("returns undefined when no model flag present", () => {
    assert.equal(parseModelFromArgs(["--permission-mode", "plan"]), undefined);
    assert.equal(parseModelFromArgs([]), undefined);
    // bare trailing flag with no value
    assert.equal(parseModelFromArgs(["--model"]), undefined);
  });
});

describe("session/new model advertisement", () => {
  it("advertises the argv model as a config option with currentValue", () => {
    _setExtraClaudeArgsForTest(["--model", "claude-sonnet-5"]);
    const r = handleNewSession({ cwd: "/tmp" }) as {
      sessionId: string;
      configOptions?: AcpConfigOption[];
    };
    assert.ok(r.configOptions, "configOptions missing");
    const model = r.configOptions.find((o) => o.id === "model");
    assert.ok(model, "model option missing");
    assert.equal(model.currentValue, "claude-sonnet-5");
    assert.deepEqual(
      model.options?.map((o) => o.value),
      ["claude-sonnet-5"],
    );
  });

  it("advertises no model option when argv has no model (nothing to describe)", () => {
    _setExtraClaudeArgsForTest([]);
    const r = handleNewSession({ cwd: "/tmp" }) as {
      configOptions?: AcpConfigOption[];
    };
    assert.equal(r.configOptions?.find((o) => o.id === "model"), undefined);
  });

  it("session/load advertises the same option for the resume path", () => {
    _setExtraClaudeArgsForTest(["--model", "claude-sonnet-5"]);
    const r = handleLoadSession({ sessionId: "s1", cwd: "/tmp" }) as {
      configOptions?: AcpConfigOption[];
    };
    assert.equal(r.configOptions?.find((o) => o.id === "model")?.currentValue, "claude-sonnet-5");
  });
});

describe("handleSetConfigOption", () => {
  it("stores the model override on the session", () => {
    _setExtraClaudeArgsForTest(["--model", "claude-sonnet-5"]);
    const { sessionId } = handleNewSession({ cwd: "/tmp" }) as { sessionId: string };
    const r = handleSetConfigOption({
      sessionId,
      configId: "model",
      value: "claude-opus-4-8",
    });
    assert.deepEqual(r, {});
    assert.equal(sessions.get(sessionId)?.modelOverride, "claude-opus-4-8");
  });

  it("accepts freeform ids even when argv advertised a different model", () => {
    _setExtraClaudeArgsForTest(["--model", "claude-sonnet-5"]);
    const { sessionId } = handleNewSession({ cwd: "/tmp" }) as { sessionId: string };
    handleSetConfigOption({ sessionId, configId: "model", value: "claude-fable-5" });
    assert.equal(sessions.get(sessionId)?.modelOverride, "claude-fable-5");
  });

  it("rejects unknown sessions, unknown configIds, and empty values", () => {
    const { sessionId } = handleNewSession({ cwd: "/tmp" }) as { sessionId: string };
    assert.throws(
      () => handleSetConfigOption({ sessionId: "nope", configId: "model", value: "x" }),
      /unknown session/,
    );
    assert.throws(
      () => handleSetConfigOption({ sessionId, configId: "temperature", value: "1" }),
      /unknown configId/,
    );
    assert.throws(
      () => handleSetConfigOption({ sessionId, configId: "model", value: "  " }),
      /non-empty/,
    );
  });
});

describe("thought_level config option", () => {
  it("is always advertised with currentValue default and claude's effort levels", () => {
    _setExtraClaudeArgsForTest([]);
    const r = handleNewSession({ cwd: "/tmp" }) as { configOptions?: AcpConfigOption[] };
    const opt = r.configOptions?.find((o) => o.category === "thought_level");
    assert.ok(opt, "thought_level option missing");
    assert.equal(opt.id, "thought_level");
    assert.equal(opt.currentValue, "default");
    assert.deepEqual(
      opt.options?.map((o) => o.value),
      ["default", "low", "medium", "high", "xhigh", "max"],
    );
  });

  it("stores a valid level (case-insensitive) and advertises it as currentValue", () => {
    const { sessionId } = handleNewSession({ cwd: "/tmp" }) as { sessionId: string };
    handleSetConfigOption({ sessionId, configId: "thought_level", value: "High" });
    const state = sessions.get(sessionId)!;
    assert.equal(state.thoughtLevel, "high");
    assert.equal(thoughtLevelConfigOption(state).currentValue, "high");
  });

  it("session/load starts a fresh state, so the level resets to default", () => {
    const { sessionId } = handleNewSession({ cwd: "/tmp" }) as { sessionId: string };
    handleSetConfigOption({ sessionId, configId: "thought_level", value: "max" });
    const r = handleLoadSession({ sessionId, cwd: "/tmp", mcpServers: [] }) as {
      configOptions?: AcpConfigOption[];
    };
    assert.equal(r.configOptions?.find((o) => o.id === "thought_level")?.currentValue, "default");
  });

  it("'default' clears a previous level", () => {
    const { sessionId } = handleNewSession({ cwd: "/tmp" }) as { sessionId: string };
    handleSetConfigOption({ sessionId, configId: "thought_level", value: "max" });
    handleSetConfigOption({ sessionId, configId: "thought_level", value: "default" });
    assert.equal(sessions.get(sessionId)?.thoughtLevel, undefined);
  });

  it("rejects levels claude would refuse", () => {
    const { sessionId } = handleNewSession({ cwd: "/tmp" }) as { sessionId: string };
    assert.throws(
      () => handleSetConfigOption({ sessionId, configId: "thought_level", value: "ultra" }),
      /unknown thought_level/,
    );
  });
});
