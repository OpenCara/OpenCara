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
import { readFileSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config/store.js";
import { WsClient } from "../transport/ws-client.js";
import { runJob } from "../runner/spawn.js";
import type {
  AgentSpec,
  JobAssignment,
  ServerToDeviceMessage,
  SystemInfo,
} from "@opencara/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = readPkgVersion();

const LOG_FLUSH_MS = 800;
const MAX_CHUNK_SIZE = 4 * 1024;

interface PendingChunks {
  stdout: string;
  stderr: string;
}

export async function run(): Promise<void> {
  const cfg = readConfig();
  if (!cfg) {
    throw new Error("Not paired. Run 'opencara register' first.");
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
        capabilities: [],
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

  try {
    const result = await runJob(job.spec as AgentSpec, job.stdinJson, {
      onLog: (stream, chunk) => {
        pending[stream] += chunk;
        scheduleFlush();
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

function readPkgVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, "..", "..", "package.json"), "utf8");
    return JSON.parse(raw).version ?? "0.0.0";
  } catch {
    return "0.0.0";
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
