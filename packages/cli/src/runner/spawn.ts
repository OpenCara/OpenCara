// Two job-execution paths share this module:
//   - `runJob`: legacy stdin-JSON envelope. Kept until #30 deletes the
//     fenced-block parser. Used by every kind not yet migrated.
//   - `runAcpJob` (re-exported from acpRunner): ACP+MCP path. Used when
//     `spec.acp` is set, which the orchestrator does only behind the
//     feature flag in the chat route (#29).
//
// Callers in `commands/run.ts` branch on `spec.acp` and pick one. The
// AcpRunController returned by `runAcpJob` lets the WS receiver route
// `agent-call-result` frames to the right run by id.

import { spawn } from "node:child_process";
import type { AgentSpec } from "@opencara/shared";

export interface SpawnHandlers {
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface SpawnResult {
  exitCode: number;
}

export function runJob(
  spec: AgentSpec,
  stdinJson: unknown | undefined,
  handlers: SpawnHandlers,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(spec.command, spec.args ?? [], {
      env: { ...process.env, ...(spec.env ?? {}) },
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => handlers.onLog("stdout", c));
    child.stderr.on("data", (c: string) => handlers.onLog("stderr", c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? -1 }));

    if (stdinJson !== undefined) {
      try {
        child.stdin.end(JSON.stringify(stdinJson));
      } catch (err) {
        child.kill();
        reject(err as Error);
        return;
      }
    } else {
      child.stdin.end();
    }
  });
}

export { runAcpJob } from "./acpRunner.js";
export type { AcpRunController, AcpRunHandlers, AcpRunResult } from "./acpRunner.js";
