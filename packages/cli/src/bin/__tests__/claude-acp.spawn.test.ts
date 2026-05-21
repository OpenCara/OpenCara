// Integration: drive the real claude-acp module end-to-end against a
// fake `claude` binary on PATH, with a prompt large enough to have
// tripped Linux's MAX_ARG_STRLEN (128 KiB) when we passed it on argv.
//
// Regression: pre-fix, the shim died with a synchronous `spawn E2BIG`
// for any prompt > 128 KiB. The orchestrator saw exit=1 in <1s with
// zero stderr captured, because the `claude` child never existed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const shimSrc = join(here, "..", "..", "claude-acp.ts");

/**
 * Drive the shim through initialize → session/new → session/prompt and
 * resolve with the parsed `session/prompt` response. Throws if the shim
 * crashes or replies with an error.
 */
async function driveShim(promptText: string, env: NodeJS.ProcessEnv): Promise<{
  stopReason: string;
  shimStderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", shimSrc], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stderr = "";
    let stdoutBuf = "";
    const pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
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
        let msg: { id?: number; method?: string; result?: unknown; error?: unknown };
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === "number") {
          const cb = pending.get(msg.id);
          if (cb) { pending.delete(msg.id); cb(msg); }
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (pending.size > 0) {
        reject(new Error(`shim exited (code=${code}) with ${pending.size} pending request(s); stderr=${stderr}`));
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
        const sess = await req("session/new", { cwd: "/tmp", mcpServers: [] });
        const sessionId = (sess.result as { sessionId: string }).sessionId;
        const prompt = await req("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: promptText }],
        });
        child.stdin.end();
        if (prompt.error) {
          reject(new Error(`session/prompt errored: ${JSON.stringify(prompt.error)}; stderr=${stderr}`));
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

describe("claude-acp spawn path", () => {
  it("accepts a prompt larger than MAX_ARG_STRLEN (regression: spawn E2BIG)", async () => {
    // 200 KiB — comfortably above the 128 KiB per-argv limit on a
    // typical 4 KiB-page x86_64 kernel. Pre-fix this would have
    // thrown `spawn E2BIG` synchronously inside runClaudeTurn.
    const PROMPT_BYTES = 200 * 1024;
    const bigPrompt = "x".repeat(PROMPT_BYTES);

    const dir = mkdtempSync(join(tmpdir(), "claude-acp-spawn-"));
    const fakeClaude = join(dir, "claude");
    // Fake `claude`: drain stdin, assert it carries the full prompt
    // (proving the shim used the stdin path, not argv), then emit a
    // minimal `result` event so the shim resolves with end_turn.
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
let bytes = 0;
process.stdin.on("data", (c) => { bytes += c.length; });
process.stdin.on("end", () => {
  if (bytes < ${PROMPT_BYTES}) {
    process.stderr.write("fake-claude: short stdin: " + bytes + " < ${PROMPT_BYTES}\\n");
    process.exit(2);
  }
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
      const { stopReason, shimStderr } = await driveShim(bigPrompt, env);
      assert.equal(stopReason, "end_turn", `shim stderr: ${shimStderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes ACP mcpServers through to claude as --mcp-config + --strict-mcp-config", async () => {
    // Regression: pre-fix the shim silently dropped session/new's
    // mcpServers, so Claude only saw the user's `~/.claude/settings.json`
    // — opencara-mcp tools never reached the agent's tool list.
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-mcp-"));
    const fakeClaude = join(dir, "claude");
    const argvDump = join(dir, "argv.json");
    // Fake `claude`: dump argv to a file, drain stdin (the shim sends
    // the prompt that way), emit a clean `result` event.
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

    const mcpServers = [
      {
        type: "stdio",
        name: "opencara",
        command: "opencara-mcp",
        args: ["--debug"],
        env: [{ name: "OPENCARA_MCP_IPC_SOCKET", value: "/tmp/test.sock" }],
      },
    ];

    try {
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
      await driveShimWithMcp("hi", env, mcpServers);
      assert.ok(existsSync(argvDump), "fake claude should have dumped argv");
      const argv = JSON.parse(readFileSync(argvDump, "utf8")) as string[];

      const cfgIdx = argv.indexOf("--mcp-config");
      assert.notEqual(cfgIdx, -1, `expected --mcp-config in argv; got ${JSON.stringify(argv)}`);
      assert.ok(argv.includes("--strict-mcp-config"), `expected --strict-mcp-config in argv; got ${JSON.stringify(argv)}`);

      const cfgJson = argv[cfgIdx + 1]!;
      const cfg = JSON.parse(cfgJson) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      };
      assert.deepEqual(cfg, {
        mcpServers: {
          opencara: {
            command: "opencara-mcp",
            args: ["--debug"],
            env: { OPENCARA_MCP_IPC_SOCKET: "/tmp/test.sock" },
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits --mcp-config when ACP session/new sends no mcpServers", async () => {
    // No regression to gate — just guard that the bridge stays opt-in.
    // A shim that always passes --mcp-config (with `{}`) would be a
    // subtler bug that prevents falling back to settings.json for
    // non-opencara use cases.
    const dir = mkdtempSync(join(tmpdir(), "claude-acp-no-mcp-"));
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
      await driveShim("hi", env);
      const argv = JSON.parse(readFileSync(argvDump, "utf8")) as string[];
      assert.ok(!argv.includes("--mcp-config"), `expected no --mcp-config; got ${JSON.stringify(argv)}`);
      assert.ok(!argv.includes("--strict-mcp-config"), `expected no --strict-mcp-config; got ${JSON.stringify(argv)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Variant of driveShim that lets the test inject mcpServers into
// session/new. Kept inline to avoid disturbing the original helper's
// signature, which the prompt-size regression test pins.
async function driveShimWithMcp(
  promptText: string,
  env: NodeJS.ProcessEnv,
  mcpServers: unknown[],
): Promise<{ stopReason: string; shimStderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", shimSrc], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stderr = "";
    let stdoutBuf = "";
    const pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
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
        let msg: { id?: number; method?: string; result?: unknown; error?: unknown };
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === "number") {
          const cb = pending.get(msg.id);
          if (cb) { pending.delete(msg.id); cb(msg); }
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (pending.size > 0) {
        reject(new Error(`shim exited (code=${code}) with ${pending.size} pending request(s); stderr=${stderr}`));
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
        const sess = await req("session/new", { cwd: "/tmp", mcpServers });
        const sessionId = (sess.result as { sessionId: string }).sessionId;
        const prompt = await req("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: promptText }],
        });
        child.stdin.end();
        if (prompt.error) {
          reject(new Error(`session/prompt errored: ${JSON.stringify(prompt.error)}; stderr=${stderr}`));
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
