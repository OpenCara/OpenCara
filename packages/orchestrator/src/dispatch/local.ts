import { spawn } from "node:child_process";
import type { AgentSpec } from "@opencara/shared";
import type { AgentDispatcher, RunContext, RunResult } from "./dispatcher.js";

export class LocalSubprocessDispatcher implements AgentDispatcher {
  constructor(private opts: { defaultCwd?: string } = {}) {}

  run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(spec.command, spec.args ?? [], {
        env: { ...process.env, ...(spec.env ?? {}) },
        cwd: spec.cwd ?? this.opts.defaultCwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutCaptured = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutCaptured += chunk;
        ctx.onLog("stdout", chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        ctx.onLog("stderr", chunk);
      });

      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ exitCode: code ?? -1, stdoutCaptured });
      });

      if (ctx.stdinJson !== undefined) {
        try {
          child.stdin.end(JSON.stringify(ctx.stdinJson));
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
}
