import { spawn } from "node:child_process";
import type { AgentSpec } from "@openkira/shared";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runAgent(spec: AgentSpec): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      cwd: spec.cwd,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
