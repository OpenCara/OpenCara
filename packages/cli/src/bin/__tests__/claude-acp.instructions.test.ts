// Unit + integration tests for the project-level instructions file
// plumbing in claude-acp (issue #130).
//
// Unit half: `resolveInstructionsFile` validation + read behaviour.
// Integration half: drive the shim with a `claude` stub that dumps argv
// and assert the spawned invocation gets `--bare --append-system-prompt
// <content>` exactly when the file resolves, and no extra flags
// otherwise.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleLoadSession,
  handleNewSession,
  resolveInstructionsFile,
  sessions,
} from "../claude-acp.js";

const here = fileURLToPath(import.meta.url);
const shimSrc = join(here, "..", "..", "claude-acp.ts");

beforeEach(() => sessions.clear());

describe("resolveInstructionsFile", () => {
  it("returns null when relative is undefined / empty (injection disabled)", () => {
    assert.equal(resolveInstructionsFile("/tmp", undefined), null);
    assert.equal(resolveInstructionsFile("/tmp", ""), null);
  });

  it("returns null when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-instr-"));
    try {
      assert.equal(resolveInstructionsFile(dir, "AGENTS.md"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the file when it exists inside cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-instr-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# Be good\nFollow the rules.\n");
      const r = resolveInstructionsFile(dir, "AGENTS.md");
      assert.ok(r, "expected a resolved entry");
      assert.equal(r!.content, "# Be good\nFollow the rules.\n");
      assert.equal(r!.path, join(dir, "AGENTS.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads from a nested path", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-instr-"));
    try {
      mkdirSync(join(dir, ".opencara"));
      writeFileSync(join(dir, ".opencara", "instructions.md"), "nested ok");
      const r = resolveInstructionsFile(dir, ".opencara/instructions.md");
      assert.ok(r);
      assert.equal(r!.content, "nested ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects absolute relative paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-instr-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "x");
      assert.equal(resolveInstructionsFile(dir, "/etc/passwd"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects paths containing '..' segments", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-instr-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "x");
      assert.equal(resolveInstructionsFile(dir, "../passwd"), null);
      assert.equal(resolveInstructionsFile(dir, "foo/../../escape.md"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects when cwd is not absolute", () => {
    assert.equal(resolveInstructionsFile("rel/cwd", "AGENTS.md"), null);
  });

  it("rejects files larger than 64 KiB", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-instr-"));
    try {
      // 65 KiB
      writeFileSync(join(dir, "AGENTS.md"), "x".repeat(65 * 1024));
      assert.equal(resolveInstructionsFile(dir, "AGENTS.md"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects directories disguised as the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-instr-"));
    try {
      mkdirSync(join(dir, "AGENTS.md"));
      assert.equal(resolveInstructionsFile(dir, "AGENTS.md"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("handleNewSession / handleLoadSession instructionsFile capture", () => {
  it("stores instructionsFile on session/new", () => {
    const r = handleNewSession({
      cwd: "/wt/branch",
      instructionsFile: "AGENTS.md",
    } as { cwd: string; instructionsFile?: unknown }) as { sessionId: string };
    assert.equal(sessions.get(r.sessionId)?.instructionsFile, "AGENTS.md");
  });

  it("stores instructionsFile on session/load", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    handleLoadSession({
      sessionId: id,
      cwd: "/wt/branch",
      instructionsFile: "  AGENTS.md  ",
    } as { sessionId: string; cwd: string; instructionsFile?: unknown });
    // Trims whitespace.
    assert.equal(sessions.get(id)?.instructionsFile, "AGENTS.md");
  });

  it("omits instructionsFile when missing / empty / non-string", () => {
    for (const v of [undefined, "", "   ", null, 42, {}]) {
      const r = handleNewSession({
        cwd: "/x",
        instructionsFile: v,
      } as never) as { sessionId: string };
      assert.equal(
        sessions.get(r.sessionId)?.instructionsFile,
        undefined,
        `should omit for ${JSON.stringify(v)}`,
      );
    }
  });
});

describe("claude-acp end-to-end with project instructions file", () => {
  it("passes --bare + --append-system-prompt <content> when the file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-bare-"));
    const fakeClaude = join(dir, "claude");
    const argvDump = join(dir, "argv.json");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(2)));
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "ok"
  }) + "\\n");
});
`,
      { mode: 0o755 },
    );
    chmodSync(fakeClaude, 0o755);
    // The worktree's project-level instructions file.
    writeFileSync(join(dir, "AGENTS.md"), "PROJECT RULE: commit and push\n");

    try {
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
      await driveShim({
        cwd: dir,
        instructionsFile: "AGENTS.md",
        env,
      });
      assert.ok(existsSync(argvDump));
      const argv = JSON.parse(readFileSync(argvDump, "utf8")) as string[];
      assert.ok(argv.includes("--bare"), `expected --bare; got ${JSON.stringify(argv)}`);
      const appendIdx = argv.indexOf("--append-system-prompt");
      assert.notEqual(appendIdx, -1, "expected --append-system-prompt");
      assert.equal(argv[appendIdx + 1], "PROJECT RULE: commit and push\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits --bare + --append-system-prompt when no instructionsFile is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-nobare-"));
    const fakeClaude = join(dir, "claude");
    const argvDump = join(dir, "argv.json");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(2)));
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "ok"
  }) + "\\n");
});
`,
      { mode: 0o755 },
    );
    chmodSync(fakeClaude, 0o755);

    try {
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
      await driveShim({ cwd: dir, env });
      const argv = JSON.parse(readFileSync(argvDump, "utf8")) as string[];
      assert.ok(!argv.includes("--bare"), `expected no --bare; got ${JSON.stringify(argv)}`);
      assert.ok(
        !argv.includes("--append-system-prompt"),
        `expected no --append-system-prompt; got ${JSON.stringify(argv)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits --bare when instructionsFile is set but the file is absent", async () => {
    // Fall-through behaviour: missing project file should NOT silently
    // disable keychain reads. Operators see the stderr skip line and the
    // run continues as if no file was configured.
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-missing-"));
    const fakeClaude = join(dir, "claude");
    const argvDump = join(dir, "argv.json");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(2)));
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "ok"
  }) + "\\n");
});
`,
      { mode: 0o755 },
    );
    chmodSync(fakeClaude, 0o755);

    try {
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
      const { shimStderr } = await driveShim({
        cwd: dir,
        // File doesn't exist in cwd → resolve fails → fall-through.
        instructionsFile: "AGENTS.md",
        env,
      });
      const argv = JSON.parse(readFileSync(argvDump, "utf8")) as string[];
      assert.ok(!argv.includes("--bare"), `expected no --bare; got ${JSON.stringify(argv)}`);
      assert.ok(
        !argv.includes("--append-system-prompt"),
        `expected no --append-system-prompt; got ${JSON.stringify(argv)}`,
      );
      assert.match(shimStderr, /instructionsFile skipped/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Drive the shim through initialize → session/new (with optional
 * instructionsFile) → session/prompt. Returns the prompt result and the
 * captured stderr so tests can assert skip-reason lines.
 */
async function driveShim(opts: {
  cwd: string;
  instructionsFile?: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ stopReason: string; shimStderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", shimSrc], {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env,
    });
    let stderr = "";
    let stdoutBuf = "";
    const pending = new Map<
      number,
      (m: { result?: unknown; error?: unknown }) => void
    >();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdoutBuf += c;
      let i: number;
      while ((i = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, i);
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: { id?: number; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.id === "number") {
          const cb = pending.get(msg.id);
          if (cb) {
            pending.delete(msg.id);
            cb(msg);
          }
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (pending.size > 0) {
        reject(
          new Error(
            `shim exited (code=${code}) with ${pending.size} pending; stderr=${stderr}`,
          ),
        );
      }
    });

    let nextId = 1;
    const req = (method: string, params: unknown) =>
      new Promise<{ result?: unknown; error?: unknown }>((res) => {
        const id = nextId++;
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    (async () => {
      try {
        await req("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const newParams: Record<string, unknown> = {
          cwd: opts.cwd,
          mcpServers: [],
        };
        if (opts.instructionsFile) newParams.instructionsFile = opts.instructionsFile;
        const sess = await req("session/new", newParams);
        const sessionId = (sess.result as { sessionId: string }).sessionId;
        const prompt = await req("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "hi" }],
        });
        child.stdin.end();
        if (prompt.error) {
          reject(
            new Error(
              `session/prompt errored: ${JSON.stringify(prompt.error)}; stderr=${stderr}`,
            ),
          );
          return;
        }
        const stopReason = (prompt.result as { stopReason: string }).stopReason;
        resolve({ stopReason, shimStderr: stderr });
      } catch (e) {
        reject(e);
      }
    })();
  });
}
