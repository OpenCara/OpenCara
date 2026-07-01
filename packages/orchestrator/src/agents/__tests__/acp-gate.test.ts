import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acpCommandFor,
  buildAcpSpec,
  checkAcpEligibility,
  defaultAcpArgsFor,
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
