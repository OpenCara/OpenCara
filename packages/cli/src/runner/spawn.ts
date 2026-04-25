import { spawn } from "node:child_process";
import type { AgentSpec } from "@openkira/shared";

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
