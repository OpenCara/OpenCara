// Tests for the non-ACP fast-path in run.ts that handles
// `opencara internal …` jobs (worktree create / write-session /
// remove). Regression: pre-fix the device rejected these with
// "legacy stdin-JSON dispatch removed in v0.30 — orchestrator must
// send spec.acp" because the orchestrator dispatches them without
// an `acp` block, and the device's blanket "no acp = reject" check
// fired before any infrastructure-vs-agent distinction.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpec, DeviceToServerMessage, JobAssignment } from "@opencara/shared";

import {
  isInternalCommand,
  runInternalCommand,
  type InternalJobSender,
} from "../run.js";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    kind: "internal:test",
    command: "opencara",
    args: ["internal", "worktree", "create"],
    env: {},
    ...over,
  };
}

function job(spec_: AgentSpec, runId = "run-test"): JobAssignment {
  return {
    type: "job",
    run: {
      id: runId,
      spec: spec_,
      status: "assigned",
      hostId: "host-test",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
    },
    spec: spec_,
  };
}

function recorder(): { client: InternalJobSender; sent: DeviceToServerMessage[] } {
  const sent: DeviceToServerMessage[] = [];
  return {
    sent,
    client: { send: (m) => sent.push(m) },
  };
}

describe("isInternalCommand", () => {
  it("matches `opencara internal …` specs", () => {
    assert.equal(isInternalCommand(spec()), true);
    assert.equal(isInternalCommand(spec({ args: ["internal", "anything"] })), true);
  });

  it("rejects non-opencara commands and non-internal subcommands", () => {
    assert.equal(isInternalCommand(spec({ command: "claude-acp" })), false);
    assert.equal(isInternalCommand(spec({ command: "node" })), false);
    assert.equal(isInternalCommand(spec({ args: ["status"] })), false);
    assert.equal(isInternalCommand(spec({ args: [] })), false);
  });
});

describe("runInternalCommand", () => {
  it("streams stdout to log frames and resolves succeeded on exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "internal-cmd-ok-"));
    const fakeBin = join(dir, "bin.mjs");
    writeFileSync(
      fakeBin,
      `console.log("worktree-path=/tmp/wt-abc"); process.exit(0);`,
    );
    try {
      const { client, sent } = recorder();
      await runInternalCommand(job(spec()), client, { binPath: fakeBin });
      const logs = sent.filter((m): m is Extract<typeof m, { type: "log" }> => m.type === "log");
      assert.equal(logs.length >= 1, true, `expected at least one log frame, got ${logs.length}`);
      const stdout = logs.filter((l) => l.stream === "stdout").map((l) => l.chunk).join("");
      assert.match(stdout, /worktree-path=\/tmp\/wt-abc/);
      const done = sent.find((m): m is Extract<typeof m, { type: "done" }> => m.type === "done");
      assert.ok(done, "expected a done frame");
      assert.equal(done!.status, "succeeded");
      assert.equal(done!.exitCode, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves failed with the child's exit code on non-zero exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "internal-cmd-fail-"));
    const fakeBin = join(dir, "bin.mjs");
    writeFileSync(
      fakeBin,
      `process.stderr.write("boom\\n"); process.exit(2);`,
    );
    try {
      const { client, sent } = recorder();
      await runInternalCommand(job(spec()), client, { binPath: fakeBin });
      const done = sent.find((m): m is Extract<typeof m, { type: "done" }> => m.type === "done");
      assert.ok(done, "expected a done frame");
      assert.equal(done!.status, "failed");
      assert.equal(done!.exitCode, 2);
      const stderr = sent
        .filter((m): m is Extract<typeof m, { type: "log" }> => m.type === "log")
        .filter((l) => l.stream === "stderr")
        .map((l) => l.chunk)
        .join("");
      assert.match(stderr, /boom/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a spawn error via done.errorMessage when the bin is missing", async () => {
    const { client, sent } = recorder();
    await runInternalCommand(job(spec()), client, {
      binPath: "/nonexistent/path/to/bin.js",
      nodePath: "/nonexistent/node",
    });
    const done = sent.find((m): m is Extract<typeof m, { type: "done" }> => m.type === "done");
    assert.ok(done, "expected a done frame");
    assert.equal(done!.status, "failed");
    assert.match(done!.errorMessage ?? "", /internal spawn error/);
  });

  it("forwards spec.env into the child process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "internal-cmd-env-"));
    const fakeBin = join(dir, "bin.mjs");
    writeFileSync(
      fakeBin,
      `console.log("X=" + process.env.MY_TEST_VAR); process.exit(0);`,
    );
    try {
      const { client, sent } = recorder();
      await runInternalCommand(
        job(spec({ env: { MY_TEST_VAR: "hello" } })),
        client,
        { binPath: fakeBin },
      );
      const stdout = sent
        .filter((m): m is Extract<typeof m, { type: "log" }> => m.type === "log")
        .filter((l) => l.stream === "stdout")
        .map((l) => l.chunk)
        .join("");
      assert.match(stdout, /X=hello/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
