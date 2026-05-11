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
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
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
});
