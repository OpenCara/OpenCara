import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acpCommandFor,
  buildAcpSpec,
  checkAcpEligibility,
  defaultAcpArgsFor,
  effectiveModelArg,
  resolveAdapterArgs,
  resolveAdapterInvocation,
  splitModelArg,
} from "../acp-gate.js";

const baseOpts = {
  agent: { kind: "claude", name: "claude-default", cwd: "/wt/branch" },
  env: {},
  systemPromptMd: "system",
  userPromptMd: "user",
};

describe("buildAcpSpec priorSessionId", () => {
  it("threads priorSessionId onto the AcpSpec when set", () => {
    const spec = buildAcpSpec({ ...baseOpts, priorSessionId: "abc-123" });
    assert.equal(spec.acp?.priorSessionId, "abc-123");
  });

  it("omits priorSessionId entirely when not set (clean wire shape)", () => {
    const spec = buildAcpSpec({ ...baseOpts });
    assert.equal(spec.acp?.priorSessionId, undefined);
    assert.equal("priorSessionId" in (spec.acp ?? {}), false);
  });

  it("omits priorSessionId when explicitly undefined (no zero-value pollution)", () => {
    const spec = buildAcpSpec({ ...baseOpts, priorSessionId: undefined });
    assert.equal("priorSessionId" in (spec.acp ?? {}), false);
  });
});

describe("splitModelArg", () => {
  it("extracts `--model <v>` and removes it from rest", () => {
    assert.deepEqual(splitModelArg(["--model", "gpt-5.5"]), {
      model: "gpt-5.5",
      rest: [],
    });
  });
  it("extracts `-m <v>`", () => {
    assert.deepEqual(splitModelArg(["-m", "kimi/k2"]), {
      model: "kimi/k2",
      rest: [],
    });
  });
  it("extracts the `--model=<v>` / `-m=<v>` forms", () => {
    assert.deepEqual(splitModelArg(["--model=o3"]), { model: "o3", rest: [] });
    assert.deepEqual(splitModelArg(["-m=o3"]), { model: "o3", rest: [] });
  });
  it("preserves surrounding non-model args", () => {
    assert.deepEqual(
      splitModelArg(["--permission-mode", "bypassPermissions", "--model", "x"]),
      { model: "x", rest: ["--permission-mode", "bypassPermissions"] },
    );
  });
  it("returns no model when none is present", () => {
    assert.deepEqual(splitModelArg(["--foo", "bar"]), {
      model: undefined,
      rest: ["--foo", "bar"],
    });
  });
});

describe("resolveAdapterInvocation — per-adapter model translation", () => {
  const codexAdapter = ["--yes", "@zed-industries/codex-acp"];
  const opencodeAdapter = ["--yes", "opencode-ai@latest", "acp"];

  it("codex: model becomes `-c model=\"<v>\"`, never `--model` (codex-acp rejects --model)", () => {
    const { args, env } = resolveAdapterInvocation(
      "codex",
      codexAdapter,
      ["--model", "gpt-5.5"],
      {},
    );
    assert.deepEqual(args, [
      "--yes",
      "@zed-industries/codex-acp",
      "-c",
      'model="gpt-5.5"',
    ]);
    assert.equal(args.includes("--model"), false);
    assert.deepEqual(env, {});
  });

  it("opencode: model goes to OPENCODE_MODEL env and is stripped from argv (`acp` has no model flag)", () => {
    const { args, env } = resolveAdapterInvocation(
      "opencode",
      opencodeAdapter,
      ["-m", "kimi-for-coding/k2p6"],
      { EXISTING: "1" },
    );
    assert.deepEqual(args, ["--yes", "opencode-ai@latest", "acp"]);
    assert.equal(args.includes("-m"), false);
    assert.equal(env.OPENCODE_MODEL, "kimi-for-coding/k2p6");
    assert.equal(env.EXISTING, "1");
  });

  it("claude: keeps `--model` on argv (claude-acp accepts it) and other args", () => {
    const { args, env } = resolveAdapterInvocation(
      "claude",
      [],
      ["--permission-mode", "bypassPermissions", "--model", "claude-sonnet-4-6"],
      {},
    );
    assert.deepEqual(args, [
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-sonnet-4-6",
    ]);
    assert.deepEqual(env, {});
  });

  it("unknown/unverified kind (pi) passes args through unchanged", () => {
    const { args } = resolveAdapterInvocation(
      "pi",
      ["--yes", "pi-acp@latest"],
      ["--model", "x"],
      {},
    );
    assert.deepEqual(args, ["--yes", "pi-acp@latest", "--model", "x"]);
  });

  it("codex/opencode with no model configured are untouched", () => {
    assert.deepEqual(
      resolveAdapterInvocation("codex", codexAdapter, [], {}).args,
      codexAdapter,
    );
    const oc = resolveAdapterInvocation("opencode", opencodeAdapter, [], {});
    assert.deepEqual(oc.args, opencodeAdapter);
    assert.deepEqual(oc.env, {});
  });
});

describe("buildAcpSpec — model translation end to end", () => {
  const base = {
    env: {},
    systemPromptMd: "system",
    userPromptMd: "user",
  };

  it("codex agent: --model gpt-5.5 → `-c model=\"gpt-5.5\"` (the bug that exited code 2)", () => {
    const spec = buildAcpSpec({
      ...base,
      agent: { kind: "codex", name: "Codex GPT", cwd: null, args: ["--model", "gpt-5.5"] },
    });
    assert.equal(spec.command, "npx");
    assert.equal(spec.args.includes("--model"), false);
    assert.ok(spec.args.includes('model="gpt-5.5"'));
  });

  it("opencode agent: -m kimi → OPENCODE_MODEL env, no -m on argv (the bug that exited code 1)", () => {
    const spec = buildAcpSpec({
      ...base,
      agent: {
        kind: "opencode",
        name: "opencode kimi",
        cwd: null,
        args: ["-m", "kimi-for-coding/k2p6"],
      },
    });
    assert.equal(spec.args.includes("-m"), false);
    assert.equal(spec.env?.OPENCODE_MODEL, "kimi-for-coding/k2p6");
  });

  it("threads the model onto acp.model so the device selects it over ACP (pi glm-5.2)", () => {
    const spec = buildAcpSpec({
      ...base,
      agent: {
        kind: "pi",
        name: "my-pi glm-5.2",
        cwd: null,
        args: ["--model", "volcengine-ark/glm-5.2"],
      },
    });
    assert.equal(spec.acp?.model, "volcengine-ark/glm-5.2");
  });

  it("omits acp.model when the agent has no model arg", () => {
    const spec = buildAcpSpec({
      ...base,
      agent: { kind: "pi", name: "pi default", cwd: null, args: [] },
    });
    assert.equal(spec.acp?.model, undefined);
    assert.equal("model" in (spec.acp ?? {}), false);
  });
});

describe("effectiveModelArg — acpArgs override owns the model", () => {
  it("reads the override's model, not the (possibly stale) args model", () => {
    assert.equal(
      effectiveModelArg({
        args: ["--permission-mode", "bypassPermissions", "--model", "claude-opus-4-8"],
        acpArgs: ["--permission-mode", "bypassPermissions", "--model", "claude-opus-5"],
      }),
      "claude-opus-5",
    );
  });

  it("falls back to args when the override is null/empty", () => {
    assert.equal(effectiveModelArg({ args: ["--model", "x"], acpArgs: null }), "x");
    assert.equal(effectiveModelArg({ args: ["--model", "x"], acpArgs: [] }), "x");
    assert.equal(effectiveModelArg({ args: ["--model", "x"] }), "x");
  });

  it("returns undefined when the override names no parseable model (codex -c form)", () => {
    // Falling back to args here would re-leak the stale model onto acp.model.
    assert.equal(
      effectiveModelArg({
        args: ["--model", "gpt-5.5"],
        acpArgs: ["--yes", "@x/codex-acp", "-c", 'model="o3"'],
      }),
      undefined,
    );
  });

  it("returns undefined when neither list names a model", () => {
    assert.equal(effectiveModelArg({}), undefined);
    assert.equal(effectiveModelArg({ args: ["--foo"], acpArgs: ["--bar"] }), undefined);
  });
});

describe("buildAcpSpec — acp.model tracks the effective args, not the raw `args`", () => {
  const base = { env: {}, systemPromptMd: "s", userPromptMd: "u" };

  it("claude: acpArgs `--model claude-opus-5` beats a stale args `--model claude-opus-4-8`", () => {
    // The real bug: argv carried opus-5 (from the override) while acp.model
    // carried opus-4-8 (from args). The device re-applies acp.model via
    // session/set_config_option AFTER argv, so claude ran opus-4-8.
    const spec = buildAcpSpec({
      ...base,
      agent: {
        kind: "claude",
        name: "Claude Opus",
        cwd: null,
        args: ["--permission-mode", "bypassPermissions", "--model", "claude-opus-4-8"],
        acpArgs: ["--permission-mode", "bypassPermissions", "--model", "claude-opus-5"],
      },
    });
    assert.deepEqual(spec.args, [
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-opus-5",
    ]);
    assert.equal(spec.acp?.model, "claude-opus-5");
  });

  it("pi: acp.model follows the override (ACP selection is pi's only model path)", () => {
    const spec = buildAcpSpec({
      ...base,
      agent: {
        kind: "pi",
        name: "pi glm",
        cwd: null,
        args: ["--model", "volcengine-ark/glm-5.2"],
        acpArgs: ["--yes", "pi-acp@latest", "--model", "volcengine-ark/glm-5.3"],
      },
    });
    assert.equal(spec.acp?.model, "volcengine-ark/glm-5.3");
  });

  it("codex: an unparseable override model omits acp.model rather than re-leaking args", () => {
    const spec = buildAcpSpec({
      ...base,
      agent: {
        kind: "codex",
        name: "Codex GPT",
        cwd: null,
        args: ["--model", "gpt-5.5"],
        acpArgs: ["--yes", "@x/codex-acp", "-c", 'model="o3"'],
      },
    });
    assert.equal("model" in (spec.acp ?? {}), false);
  });
});

describe("buildAcpSpec — captureThinking", () => {
  const base = { env: {}, systemPromptMd: "s", userPromptMd: "u" };
  const agent = (captureThinking?: boolean) => ({
    kind: "pi",
    name: "pi glm",
    cwd: null,
    args: [],
    ...(captureThinking === undefined ? {} : { captureThinking }),
  });

  it("sends captureThinking:false so the device drops thought chunks", () => {
    const spec = buildAcpSpec({ ...base, agent: agent(false) });
    assert.equal(spec.acp?.captureThinking, false);
  });

  it("omits the field when capturing — a default-shaped spec stays clean", () => {
    // An older device ignores the field entirely, so omitting it on the
    // default keeps new-orchestrator/old-device behaviour identical.
    for (const a of [agent(true), agent(undefined)]) {
      const spec = buildAcpSpec({ ...base, agent: a });
      assert.equal("captureThinking" in (spec.acp ?? {}), false);
    }
  });
});

describe("acpCommandFor / defaultAcpArgsFor (UI-facing)", () => {
  it("acpCommandFor returns the kind-fixed executable", () => {
    assert.equal(acpCommandFor("codex"), "npx");
    assert.equal(acpCommandFor("claude"), "claude-acp");
    assert.equal(acpCommandFor("CODEX"), "npx"); // case-insensitive
    assert.equal(acpCommandFor("custom"), undefined);
  });

  it("defaultAcpArgsFor reflects the kind base args + model translation", () => {
    assert.deepEqual(defaultAcpArgsFor("codex", ["--model", "gpt-5.5"]), [
      "--yes",
      "@zed-industries/codex-acp",
      "-c",
      'model="gpt-5.5"',
    ]);
    // opencode model goes to env, so the default args are just the base.
    assert.deepEqual(defaultAcpArgsFor("opencode", ["-m", "kimi/k2"]), [
      "--yes",
      "opencode-ai@latest",
      "acp",
    ]);
    assert.equal(defaultAcpArgsFor("custom", ["x"]), undefined);
  });
});

describe("resolveAdapterArgs — override vs default", () => {
  const codex = { command: "npx", args: ["--yes", "@zed-industries/codex-acp"] };

  it("uses acpArgs verbatim when set (no base args, no translation)", () => {
    const { args, env } = resolveAdapterArgs(
      "codex",
      codex,
      { args: ["--model", "ignored"], acpArgs: ["--yes", "@x/codex", "-c", 'model="o3"'] },
      { K: "1" },
    );
    assert.deepEqual(args, ["--yes", "@x/codex", "-c", 'model="o3"']);
    assert.deepEqual(env, { K: "1" }); // override doesn't inject model env
  });

  it("falls back to the translated default when acpArgs is null/empty", () => {
    assert.deepEqual(
      resolveAdapterArgs("codex", codex, { args: ["--model", "gpt-5.5"], acpArgs: null }, {}).args,
      ["--yes", "@zed-industries/codex-acp", "-c", 'model="gpt-5.5"'],
    );
    assert.deepEqual(
      resolveAdapterArgs("codex", codex, { args: [], acpArgs: [] }, {}).args,
      ["--yes", "@zed-industries/codex-acp"],
    );
  });

  it("buildAcpSpec end-to-end: acpArgs override wins over kind default", () => {
    const spec = buildAcpSpec({
      env: {},
      systemPromptMd: "s",
      userPromptMd: "u",
      agent: {
        kind: "codex",
        name: "Codex GPT",
        cwd: null,
        args: ["--model", "gpt-5.5"],
        acpArgs: ["--yes", "@agentclientprotocol/codex-acp", "-c", 'model="gpt-5.5"'],
      },
    });
    assert.equal(spec.command, "npx");
    assert.deepEqual(spec.args, [
      "--yes",
      "@agentclientprotocol/codex-acp",
      "-c",
      'model="gpt-5.5"',
    ]);
  });
});

describe("checkAcpEligibility", () => {
  it("accepts known kinds", () => {
    assert.equal(checkAcpEligibility("claude").useAcp, true);
    assert.equal(checkAcpEligibility("codex").useAcp, true);
  });

  it("rejects unknown kinds with a refuseReason", () => {
    const r = checkAcpEligibility("custom");
    assert.equal(r.useAcp, false);
    assert.match(r.refuseReason ?? "", /not supported/);
  });
});

// ─── omp (Oh My Pi) and cursor (Cursor CLI) ─────────────────────────
// Both CLIs speak ACP natively. Verified against the real binaries on
// 2026-08-27: `omp acp` advertises a `model` config option whose values are
// provider-qualified (`volcengine-ark/kimi-k3`), and `cursor-agent acp`
// advertises parameterized ids (`grok-4.6[effort=high,fast=true]`) that it
// validates strictly — `set_config_option` with a bare `grok-4.6` is rejected
// with "Invalid model value".
describe("omp / cursor adapters", () => {
  const ompAdapter = ["--yes", "@oh-my-pi/pi-coding-agent@latest", "acp"];

  it("routes both kinds through ACP", () => {
    assert.equal(checkAcpEligibility("omp").useAcp, true);
    assert.equal(checkAcpEligibility("cursor").useAcp, true);
    assert.equal(checkAcpEligibility("CURSOR").useAcp, true); // case-insensitive
  });

  it("exposes the kind-fixed command + default args to the UI", () => {
    assert.equal(acpCommandFor("omp"), "npx");
    assert.equal(acpCommandFor("cursor"), "cursor-agent");
    assert.deepEqual(defaultAcpArgsFor("omp", []), ompAdapter);
    assert.deepEqual(defaultAcpArgsFor("cursor", []), ["acp"]);
  });

  it("omp: --model stays on argv (it tolerates the flag) and reaches acp.model", () => {
    const spec = buildAcpSpec({
      env: {},
      systemPromptMd: "system",
      userPromptMd: "user",
      agent: {
        kind: "omp",
        name: "omp kimi-k3",
        cwd: null,
        args: ["--model", "volcengine-ark/kimi-k3"],
      },
    });
    assert.equal(spec.command, "npx");
    assert.deepEqual(spec.args, [...ompAdapter, "--model", "volcengine-ark/kimi-k3"]);
    assert.equal(spec.acp?.model, "volcengine-ark/kimi-k3");
  });

  it("cursor: --model is dropped from argv but still selected over ACP", () => {
    const spec = buildAcpSpec({
      env: {},
      systemPromptMd: "system",
      userPromptMd: "user",
      agent: {
        kind: "cursor",
        name: "cursor grok-4.6",
        cwd: null,
        args: ["--model", "grok-4.6[effort=high,fast=true]", "--force"],
      },
    });
    assert.equal(spec.command, "cursor-agent");
    // argv keeps non-model extras, never the model: cursor's argv model names
    // (`cursor-grok-4.6-high`) are a different namespace from its ACP ids.
    assert.deepEqual(spec.args, ["acp", "--force"]);
    assert.equal(spec.acp?.model, "grok-4.6[effort=high,fast=true]");
  });

  it("cursor with no model configured is left untouched", () => {
    const { args, env } = resolveAdapterInvocation("cursor", ["acp"], [], {});
    assert.deepEqual(args, ["acp"]);
    assert.deepEqual(env, {});
  });

  // The acpArgs override is otherwise verbatim, but for cursor a `--model`
  // left on that line would reach `cursor-agent`'s own flag in the wrong
  // namespace. effectiveModelArg already routes the override's model to
  // acp.model, so the flag has to come off argv on this path too — otherwise
  // an operator who touches the field has no correct answer.
  it("cursor: the acpArgs override keeps its extras but loses --model", () => {
    const spec = buildAcpSpec({
      env: {},
      systemPromptMd: "system",
      userPromptMd: "user",
      agent: {
        kind: "cursor",
        name: "cursor override",
        cwd: null,
        args: ["--model", "grok-4.6[effort=low,fast=true]"],
        acpArgs: ["acp", "--model", "claude-opus-5[thinking=true]", "--force"],
      },
    });
    assert.deepEqual(spec.args, ["acp", "--force"]);
    // The override owns the model, not the stale one in `args` (see #212).
    assert.equal(spec.acp?.model, "claude-opus-5[thinking=true]");
  });

  it("non-cursor overrides stay verbatim", () => {
    const { args } = resolveAdapterArgs(
      "omp",
      { command: "npx", args: ompAdapter },
      { args: [], acpArgs: ["--yes", "omp@1.2.3", "acp", "--model", "moonshot/kimi-k3"] },
      {},
    );
    assert.deepEqual(args, ["--yes", "omp@1.2.3", "acp", "--model", "moonshot/kimi-k3"]);
  });
});
