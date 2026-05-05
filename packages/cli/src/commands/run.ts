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
import { readConfig } from "../config/store.js";
import { register } from "./register.js";
import { WsClient } from "../transport/ws-client.js";
import { runJob } from "../runner/spawn.js";
import { AgentCallParser } from "../runner/agentCallParser.js";
import type {
  AgentSpec,
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
        // Advertise the new opencara-call stdout protocol so the
        // server can later gate the skill prompt to capable CLIs.
        // Older CLIs without this capability would still be sent the
        // skill markdown today (it doesn't crash; the fenced block
        // just shows up in stdout unparsed).
        capabilities: ["agent-call"],
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

  // Parses ```opencara-call\n…\n``` fenced blocks out of the agent's
  // stdout and forwards them to the orchestrator over the same WS we got
  // the job over. Fire-and-forget: there is no response message — the
  // mutation is applied transparently and the user sees the result on
  // their canvas page. The fenced block IS still streamed back as a
  // normal log frame in the same callback, so the user sees what the
  // agent asked for in the chat reply.
  const callParser = new AgentCallParser((call) => {
    // The discriminated union forces a switch — TS won't narrow a spread
    // alone. Each arm forwards the parsed payload verbatim; validation
    // already happened in the parser.
    switch (call.kind) {
      case "issue.body.set":
        client.send({ type: "agent-call", runId, ...call });
        return;
      case "flow.node.config.set":
        client.send({ type: "agent-call", runId, ...call });
        return;
      case "template.node.config.set":
        client.send({ type: "agent-call", runId, ...call });
        return;
    }
  });

  try {
    const result = await runJob(job.spec as AgentSpec, job.stdinJson, {
      onLog: (stream, chunk) => {
        pending[stream] += chunk;
        scheduleFlush();
        if (stream === "stdout") callParser.feed(chunk);
      },
    });
    flush();
    client.send({
      type: "done",
      runId,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      exitCode: result.exitCode,
    });
    console.log(`[opencara] job ${runId.slice(-8)} → exit ${result.exitCode}`);
  } catch (err) {
    flush();
    const message = err instanceof Error ? err.message : String(err);
    client.send({ type: "done", runId, status: "failed", errorMessage: message });
    console.error(`[opencara] job ${runId.slice(-8)} failed`, message);
  }
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
