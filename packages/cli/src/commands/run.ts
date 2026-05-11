import {
  arch,
  cpus,
  freemem,
  hostname,
  networkInterfaces,
  platform,
  release,
  totalmem,
  uptime,
} from "node:os";
import { statfsSync } from "node:fs";
import { spawn } from "node:child_process";
import { readConfig } from "../config/store.js";
import { register } from "./register.js";
import { WsClient } from "../transport/ws-client.js";
import { runAcpJob, type AcpRunController } from "../runner/spawn.js";
import type {
  AgentSpec,
  DeviceToServerMessage,
  JobAssignment,
  ServerToDeviceMessage,
  SystemInfo,
} from "@opencara/shared";

// Baked at bundle time by build.mjs (`define` substitutes the literal).
// In dev (`tsx watch src/bin.ts`) the env var isn't set, so fall back.
const PKG_VERSION = process.env["OPENCARA_VERSION"] ?? "0.0.0-dev";

const LOG_FLUSH_MS = 800;
const MAX_CHUNK_SIZE = 4 * 1024;

interface PendingChunks {
  stdout: string;
  stderr: string;
}

interface RunOpts {
  url?: string;
  forcePair?: boolean;
}

export async function run(opts: RunOpts = {}): Promise<void> {
  // First-run UX: if not paired yet (or --force-pair), kick off the
  // browser-based pairing flow inline, then continue straight to the WS
  // loop. (Was two commands previously: `register` then `run`.)
  let cfg = readConfig();
  if (!cfg || opts.forcePair) {
    await register({ url: opts.url, forcePair: opts.forcePair });
    cfg = readConfig();
    if (!cfg) throw new Error("pairing did not save a config");
  }
  const wsUrl = cfg.orchestratorUrl.replace(/^http/, "ws") + "/api/devices/ws";

  const client: WsClient = new WsClient({
    url: wsUrl,
    token: cfg.token,
    onOpen: () => {
      console.log(`[opencara] connected to ${cfg.orchestratorUrl}`);
      client.send({
        type: "hello",
        platform: platform(),
        version: PKG_VERSION,
        // Advertise ACP transport support. Pre-v0.30 devices reported
        // "agent-call" (the fenced-stdout-block protocol); since the
        // legacy path was removed, this version reports "acp" so the
        // orchestrator knows the device can handle `spec.acp` jobs.
        capabilities: ["acp"],
        systemInfo: collectSystemInfo(),
      });
    },
    onMessage: (msg: ServerToDeviceMessage) => handleServerMessage(msg, client, cfg),
    onClose: (code, reason) => {
      console.log(`[opencara] disconnected (code=${code} reason="${reason}")`);
    },
  });
  console.log(`[opencara] starting as ${cfg.deviceName} (${hostname()})`);
  client.start();
}

/**
 * In-flight ACP job controllers, keyed by runId. The WS receiver looks
 * up the controller when an `agent-call-result` frame arrives so the
 * matching tool-call promise resolves on the right run.
 */
const acpControllers = new Map<string, AcpRunController>();

function handleServerMessage(
  msg: ServerToDeviceMessage,
  client: WsClient,
  _cfg: { agentHostId: string; deviceName: string },
): void {
  if (msg.type === "hello-ack") {
    console.log(`[opencara] acked as ${msg.deviceName} (${msg.agentHostId})`);
    return;
  }
  if (msg.type === "ping") return;
  if (msg.type === "job") {
    void executeJob(msg, client);
    return;
  }
  if (msg.type === "agent-call-result") {
    // Route to the active ACP run for this id. Stale results (run already
    // ended) are dropped silently — same posture as a stale log frame.
    acpControllers.get(msg.runId)?.onAgentCallResult(msg);
    return;
  }
}

async function executeJob(job: JobAssignment, client: WsClient): Promise<void> {
  const runId = job.run.id;
  console.log(`[opencara] job ${runId.slice(-8)}: ${job.spec.command}`);

  let seq = 0;
  let pending: PendingChunks = { stdout: "", stderr: "" };
  let flushTimer: NodeJS.Timeout | null = null;

  const flush = () => {
    for (const stream of ["stdout", "stderr"] as const) {
      const chunk = pending[stream];
      if (!chunk) continue;
      let remaining = chunk;
      while (remaining.length > 0) {
        const take = remaining.slice(0, MAX_CHUNK_SIZE);
        client.send({ type: "log", runId, seq: seq++, stream, chunk: take });
        remaining = remaining.slice(MAX_CHUNK_SIZE);
      }
      pending[stream] = "";
    }
    flushTimer = null;
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, LOG_FLUSH_MS);
  };

  // `opencara internal …` jobs are CLI infrastructure (worktree
  // allocate / write-session / remove), not agent runs — they have no
  // prompt, no model, no tool-use surface. Route them through a
  // non-ACP fast-path that re-invokes this same node + bundled bin.js
  // and streams stdout/stderr back as log frames. Pre-PR-#41 these
  // rode the legacy stdin-JSON path; that path got deleted on the
  // device, but the orchestrator still dispatches them as legacy-
  // shape jobs (nodeRunners.ts worktree create / write-session,
  // worktrees/cleanup.ts remove) — which is fine: those jobs aren't
  // and shouldn't be ACP, so the device just needs to handle them.
  if (isInternalCommand(job.spec)) {
    flush();
    await runInternalCommand(job, client);
    return;
  }

  // ACP+MCP is the only AGENT dispatch path post-#30. Non-internal
  // specs without `acp` are an orchestrator bug (or a stale device
  // config); fail loudly instead of silently running a no-op.
  if (!job.spec.acp) {
    flush();
    const message =
      `legacy stdin-JSON dispatch removed in v0.30 — orchestrator must send spec.acp. ` +
      `Got command: ${job.spec.command}.`;
    client.send({ type: "done", runId, status: "failed", errorMessage: message });
    console.error(`[opencara] job ${runId.slice(-8)} rejected: ${message}`);
    return;
  }

  const handle = runAcpJob({
    runId,
    spec: job.spec as AgentSpec,
    handlers: {
      onLog: (stream, chunk) => {
        pending[stream] += chunk;
        scheduleFlush();
      },
      sendAgentCall: (req) => client.send(req),
    },
  });
  acpControllers.set(runId, handle.controller);
  try {
    const result = await handle.promise;
    flush();
    client.send({
      type: "done",
      runId,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      exitCode: result.exitCode,
      acpSessionId: result.sessionId || null,
    });
    console.log(
      `[opencara] job ${runId.slice(-8)} (acp) → ${result.stopReason} exit=${result.exitCode}`,
    );
  } catch (err) {
    flush();
    const message = err instanceof Error ? err.message : String(err);
    client.send({ type: "done", runId, status: "failed", errorMessage: message });
    console.error(`[opencara] job ${runId.slice(-8)} (acp) failed`, message);
  } finally {
    acpControllers.delete(runId);
  }
}

/**
 * Minimal sender surface needed by `runInternalCommand` so tests can
 * substitute a no-op recorder instead of standing up a real WS.
 */
export interface InternalJobSender {
  send(msg: DeviceToServerMessage): void;
}

export function isInternalCommand(spec: AgentSpec): boolean {
  return (
    spec.command === "opencara" &&
    Array.isArray(spec.args) &&
    spec.args[0] === "internal"
  );
}

/**
 * Run an `opencara internal …` job by re-invoking this same node
 * binary against the bundled bin.js (or src/bin.ts under tsx in dev).
 * Streams stdout/stderr back as `log` frames and emits a `done`
 * frame with the child's exit code. No ACP, no MCP, no agent
 * machinery — these jobs are git/fs plumbing dispatched by the flow
 * engine.
 *
 * `opts.binPath` / `opts.nodePath` exist for tests to point at a
 * fake binary; in production both fall through to `process.argv[1]`
 * (the entry point that started THIS process) and `process.execPath`.
 */
export async function runInternalCommand(
  job: JobAssignment,
  client: InternalJobSender,
  opts: { binPath?: string; nodePath?: string } = {},
): Promise<void> {
  const runId = job.run.id;
  const args = job.spec.args ?? [];
  const binPath = opts.binPath ?? process.argv[1];
  const nodePath = opts.nodePath ?? process.execPath;
  if (!binPath) {
    client.send({
      type: "done",
      runId,
      status: "failed",
      errorMessage: "internal: process.argv[1] missing — cannot re-invoke bin",
    });
    return;
  }

  let seq = 0;
  const emit = (stream: "stdout" | "stderr", chunk: string): void => {
    let remaining = chunk;
    while (remaining.length > 0) {
      const take = remaining.slice(0, MAX_CHUNK_SIZE);
      client.send({ type: "log", runId, seq: seq++, stream, chunk: take });
      remaining = remaining.slice(MAX_CHUNK_SIZE);
    }
  };

  const child = spawn(nodePath, [binPath, ...args], {
    cwd: job.spec.cwd,
    env: job.spec.env ? { ...process.env, ...job.spec.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => emit("stdout", c));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => emit("stderr", c));

  const { exitCode, errorMessage } = await new Promise<{
    exitCode: number;
    errorMessage?: string;
  }>((resolve) => {
    let done = false;
    child.on("error", (err) => {
      if (done) return;
      done = true;
      resolve({ exitCode: 1, errorMessage: `internal spawn error: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      if (done) return;
      done = true;
      resolve({ exitCode: code ?? (signal ? 1 : 0) });
    });
  });

  client.send({
    type: "done",
    runId,
    status: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    ...(errorMessage ? { errorMessage } : {}),
  });
  console.log(`[opencara] job ${runId.slice(-8)} (internal) → exit=${exitCode}`);
}

/**
 * Best-effort system snapshot for the dashboard. Any field can fail
 * (e.g. statfs on weird filesystems) — fall back rather than refuse to
 * connect, the data is informational not load-bearing.
 */
function collectSystemInfo(): SystemInfo | undefined {
  try {
    const cpuList = cpus();
    const head = cpuList[0];
    const ipAddrs: string[] = [];
    const ifaces = networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const iface of list) {
        if (!iface.internal && iface.family === "IPv4") ipAddrs.push(iface.address);
      }
    }

    let disk: SystemInfo["disk"];
    try {
      const stats = statfsSync("/");
      disk = {
        path: "/",
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
      };
    } catch {
      disk = undefined;
    }

    return {
      os: platform(),
      release: release(),
      arch: arch(),
      hostname: hostname(),
      cpu: {
        model: head?.model.trim() ?? "unknown",
        cores: cpuList.length,
        speedMhz: head?.speed ?? 0,
      },
      memory: { totalBytes: totalmem(), freeBytes: freemem() },
      disk,
      ipAddrs,
      uptimeSec: Math.floor(uptime()),
    };
  } catch (err) {
    console.warn("[opencara] system info collection failed", err);
    return undefined;
  }
}
