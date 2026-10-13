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
import { CONVERSATIONS_DIR } from "../config/paths.js";
import { pruneConversations } from "../runner/conversations.js";
import type * as DurableRunner from "../runner/durableRunner.js";
import {
  HOST_PROTOCOL_VERSION,
  WS_CLOSE_PROTOCOL_TOO_OLD,
  type AgentSpec,
  type DeviceToServerMessage,
  type JobAssignment,
  type ServerToDeviceMessage,
  type SystemInfo,
} from "@opencara/shared";

type RunAgentTurn = typeof DurableRunner.runAgentTurn;

// Baked at bundle time by build.mjs (`define` substitutes the literal).
// In dev (`tsx watch src/bin.ts`) the env var isn't set, so fall back.
const PKG_VERSION = process.env["OPENCARA_VERSION"] ?? "0.0.0-dev";

const LOG_FLUSH_MS = 800;
const MAX_CHUNK_SIZE = 4 * 1024;
/** Conversations nobody resumed for this long are deleted from the device. */
const CONVERSATION_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  // Loaded here, not imported at the top: the runner pulls in pi-durable,
  // pi-ai and node:sqlite (about a second), and every `opencara internal …`
  // plumbing job starts this binary afresh without ever running a turn.
  const { runAgentTurn } = await import("../runner/durableRunner.js");

  const client: WsClient = new WsClient({
    url: wsUrl,
    token: cfg.token,
    onOpen: () => {
      console.log(`[opencara] connected to ${cfg.orchestratorUrl}`);
      client.send({
        type: "hello",
        platform: platform(),
        version: PKG_VERSION,
        protocolVersion: HOST_PROTOCOL_VERSION,
        // Informational (stored on agent_hosts, never used for routing):
        // this CLI runs agent turns in-process on pi-durable.
        capabilities: ["pi-durable"],
        systemInfo: collectSystemInfo(),
      });
    },
    onMessage: (msg: ServerToDeviceMessage) => handleServerMessage(msg, client, runAgentTurn),
    onClose: (code, reason) => {
      if (code === WS_CLOSE_PROTOCOL_TOO_OLD) {
        // WsClient already disabled reconnect for this code; make the
        // failure unmissable and exit non-zero so a supervisor restart
        // (with the same binary) doesn't loop silently either.
        console.error(
          `[opencara] this CLI's protocol is too old for the orchestrator: ${reason}`,
        );
        console.error("[opencara] upgrade with: npm i -g opencara");
        process.exitCode = 1;
        return;
      }
      console.log(`[opencara] disconnected (code=${code} reason="${reason}")`);
    },
  });
  console.log(`[opencara] starting as ${cfg.deviceName} (${hostname()})`);
  const prune = () => {
    const pruned = pruneConversations(CONVERSATIONS_DIR, CONVERSATION_MAX_IDLE_MS);
    if (pruned > 0) console.log(`[opencara] pruned ${pruned} idle conversation(s)`);
  };
  prune();
  setInterval(prune, PRUNE_INTERVAL_MS).unref();
  client.start();
}

/**
 * In-flight agent turns, keyed by runId: `cancel` frames and the results
 * of their opencara tool calls (`agent-call-result`) are routed here.
 */
const turnControllers = new Map<string, DurableRunner.TurnController>();

function handleServerMessage(
  msg: ServerToDeviceMessage,
  client: WsClient,
  runAgentTurn: RunAgentTurn,
): void {
  if (msg.type === "hello-ack") {
    console.log(`[opencara] acked as ${msg.deviceName} (${msg.agentHostId})`);
    // Version-skew visibility only — the server enforces its floor by
    // closing with WS_CLOSE_PROTOCOL_TOO_OLD; the client never gates.
    if (
      msg.protocolVersion !== undefined &&
      msg.protocolVersion !== HOST_PROTOCOL_VERSION
    ) {
      console.warn(
        `[opencara] protocol skew: server v${msg.protocolVersion}, CLI v${HOST_PROTOCOL_VERSION}` +
          (msg.protocolVersion > HOST_PROTOCOL_VERSION
            ? " — consider `npm i -g opencara`"
            : ""),
      );
    }
    return;
  }
  if (msg.type === "ping") return;
  if (msg.type === "job") {
    void executeJob(msg, client, runAgentTurn);
    return;
  }
  if (msg.type === "agent-call-result") {
    // Results for a turn that already ended are dropped, like stale logs.
    turnControllers.get(msg.runId)?.onAgentCallResult(msg);
    return;
  }
  if (msg.type === "cancel") {
    // The orchestrator has already flipped the agent_runs row to
    // `cancelled`; a cancel for a finished turn has nothing left to stop.
    const ctrl = turnControllers.get(msg.runId);
    if (ctrl) {
      console.log(
        `[opencara] job ${msg.runId.slice(-8)} cancel requested (${msg.reason})`,
      );
      ctrl.cancel();
    }
    return;
  }
}

async function executeJob(
  job: JobAssignment,
  client: WsClient,
  runAgentTurn: RunAgentTurn,
): Promise<void> {
  const runId = job.run.id;
  const { turn } = job.spec;
  console.log(
    `[opencara] job ${runId.slice(-8)}: ${turn ? `${job.spec.kind} (${turn.model})` : job.spec.command}`,
  );

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

  // `opencara internal …` jobs are CLI plumbing (worktree allocate /
  // remove), not agent turns: re-invoke this same node + bin.js and stream
  // its stdout/stderr back as log frames.
  if (isInternalCommand(job.spec)) {
    flush();
    await runInternalCommand(job, client);
    return;
  }

  if (!turn) {
    flush();
    const message = `job is neither an agent turn nor an opencara internal command (command: ${job.spec.command ?? "none"})`;
    client.send({ type: "done", runId, status: "failed", errorMessage: message });
    console.error(`[opencara] job ${runId.slice(-8)} rejected: ${message}`);
    return;
  }

  const handle = runAgentTurn({
    runId,
    spec: job.spec,
    handlers: {
      onLog: (stream, chunk) => {
        pending[stream] += chunk;
        scheduleFlush();
      },
      sendAgentCall: (req) => client.send(req),
    },
  });
  turnControllers.set(runId, handle.controller);
  try {
    const result = await handle.promise;
    flush();
    client.send({
      type: "done",
      runId,
      status: result.status,
      exitCode: result.exitCode,
      conversationId: result.conversationId,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    });
    console.log(
      `[opencara] job ${runId.slice(-8)} → ${result.status}` +
        (result.errorMessage ? `: ${result.errorMessage}` : ""),
    );
  } catch (err) {
    flush();
    const message = err instanceof Error ? err.message : String(err);
    client.send({ type: "done", runId, status: "failed", errorMessage: message });
    console.error(`[opencara] job ${runId.slice(-8)} failed`, message);
  } finally {
    turnControllers.delete(runId);
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
 * frame with the child's exit code. No agent turn involved — these
 * jobs are git/fs plumbing dispatched by the flow engine.
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
