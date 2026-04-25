import { hostname, platform } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config/store.js";
import { WsClient } from "../transport/ws-client.js";
import { runJob } from "../runner/spawn.js";
import type { AgentSpec, JobAssignment, ServerToDeviceMessage } from "@openkira/shared";

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
    throw new Error("Not paired. Run 'openkira register' first.");
  }
  const wsUrl = cfg.orchestratorUrl.replace(/^http/, "ws") + "/api/devices/ws";

  const client: WsClient = new WsClient({
    url: wsUrl,
    token: cfg.token,
    onOpen: () => {
      console.log(`[openkira] connected to ${cfg.orchestratorUrl}`);
      client.send({
        type: "hello",
        platform: platform(),
        version: PKG_VERSION,
        capabilities: [],
      });
    },
    onMessage: (msg: ServerToDeviceMessage) => handleServerMessage(msg, client, cfg),
    onClose: (code, reason) => {
      console.log(`[openkira] disconnected (code=${code} reason="${reason}")`);
    },
  });
  console.log(`[openkira] starting as ${cfg.deviceName} (${hostname()})`);
  client.start();
}

function handleServerMessage(
  msg: ServerToDeviceMessage,
  client: WsClient,
  _cfg: { agentHostId: string; deviceName: string },
): void {
  if (msg.type === "hello-ack") {
    console.log(`[openkira] acked as ${msg.deviceName} (${msg.agentHostId})`);
    return;
  }
  if (msg.type === "ping") return;
  if (msg.type === "job") {
    void executeJob(msg, client);
  }
}

async function executeJob(job: JobAssignment, client: WsClient): Promise<void> {
  const runId = job.run.id;
  console.log(`[openkira] job ${runId.slice(-8)}: ${job.spec.command}`);

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
    console.log(`[openkira] job ${runId.slice(-8)} → exit ${result.exitCode}`);
  } catch (err) {
    flush();
    const message = err instanceof Error ? err.message : String(err);
    client.send({ type: "done", runId, status: "failed", errorMessage: message });
    console.error(`[openkira] job ${runId.slice(-8)} failed`, message);
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
