// MCP smoke-test harness. Companion to packages/cli/src/acp/spike.ts (#27)
// but with opencara-mcp configured into the agent's ACP `mcpServers` so
// tool calls actually round-trip through our IPC + tool registry.
//
// Usage:
//   pnpm --filter opencara mcp:smoke "set the body of issue 1 to 'hello'"
//
// The IPC server's tool router is a STUB that returns either { ok: true }
// or { ok: false, reason: "stub: rejected" } depending on
// OPENCARA_MCP_SMOKE_REJECT. No orchestrator, no DB. Verifies that
// agent → opencara-mcp → IPC → router → result round-tripping works
// end-to-end against a real ACP agent binary.

import { mkdirSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { argv, cwd, env, exit, stderr, stdout } from "node:process";
import { randomBytes } from "node:crypto";
import { AcpClient } from "../acp/client.js";
import {
  ACP_PROTOCOL_VERSION,
  isMessageChunk,
  isToolCallStart,
  isToolCallProgress,
  type SessionNotificationParams,
} from "../acp/types.js";
import { McpHost } from "./host.js";
import type { ToolCallResult, ToolCallRouter } from "./tools.js";

interface SmokeArgs {
  prompt: string;
  command: string;
  args: string[];
  workdir: string;
  dumpDir: string;
  reject: boolean;
  runId: string;
}

function parseArgs(): SmokeArgs {
  const userArgs = argv.slice(2);
  if (userArgs.length === 0) {
    stderr.write("usage: smoke.ts \"<prompt>\"\n");
    exit(2);
  }
  return {
    prompt: userArgs.join(" "),
    command: env["OPENCARA_ACP_COMMAND"] ?? "gemini",
    args: (env["OPENCARA_ACP_ARGS"] ?? "--acp")
      .split(/\s+/)
      .filter(Boolean),
    workdir: env["OPENCARA_ACP_CWD"] ?? cwd(),
    dumpDir:
      env["OPENCARA_MCP_SMOKE_DUMP_DIR"] ??
      resolve(env["OPENCARA_ACP_CWD"] ?? cwd(), ".opencara-mcp-smoke"),
    reject: env["OPENCARA_MCP_SMOKE_REJECT"] === "1",
    runId: `smoke-${randomBytes(4).toString("hex")}`,
  };
}

async function main(): Promise<void> {
  const cli = parseArgs();
  mkdirSync(cli.dumpDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dumpPath = resolve(cli.dumpDir, `frames-${stamp}.jsonl`);
  const dump = createWriteStream(dumpPath);

  const log = (line: string): void => {
    stdout.write(line.endsWith("\n") ? line : line + "\n");
  };

  // Stub router: every tool call gets the same canned response. We log
  // the call so the operator can confirm round-trip without needing a
  // real orchestrator.
  const stubResult: ToolCallResult = cli.reject
    ? { ok: false, reason: "stub: rejected" }
    : { ok: true };
  const router: ToolCallRouter = {
    async call(kind, args) {
      log(`[smoke] tool-call: ${kind} ${JSON.stringify(args)}`);
      log(`[smoke]   stub returning ${JSON.stringify(stubResult)}`);
      return stubResult;
    },
  };

  const host = new McpHost({ runId: cli.runId, router });
  await host.start();
  log(`[smoke] runId:    ${cli.runId}`);
  log(`[smoke] mcp sock: ${host.acpServerEntry().env.find((e) => e.name === "OPENCARA_MCP_IPC_SOCKET")?.value}`);
  log(`[smoke] command:  ${cli.command} ${cli.args.join(" ")}`);
  log(`[smoke] cwd:      ${cli.workdir}`);
  log(`[smoke] dump:     ${dumpPath}`);
  log(`[smoke] reject:   ${cli.reject}`);
  log(`[smoke] prompt:   ${cli.prompt}`);
  log("");

  const client = new AcpClient({
    command: cli.command,
    args: cli.args,
    cwd: cli.workdir,
    trace: true,
  });

  client.onFrame((dir, msg) => {
    dump.write(JSON.stringify({ dir, t: Date.now(), msg }) + "\n");
  });
  client.onStderr((chunk) => {
    stderr.write(`[stderr] ${chunk.endsWith("\n") ? chunk : chunk + "\n"}`);
  });
  client.onSessionUpdate((p: SessionNotificationParams) => {
    summarizeUpdate(p, log);
  });

  client.start();

  try {
    log(`[smoke] launching: ${cli.command} ${cli.args.join(" ")}`);
    await client.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await client.newSession({
      cwd: cli.workdir,
      mcpServers: [host.acpServerEntry()],
    });
    log(`[smoke] sessionId=${session.sessionId}`);
    const result = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: cli.prompt }],
    });
    log(`[smoke] stopReason=${result.stopReason}`);
    await client.close();
  } catch (err) {
    const e = err instanceof Error ? err.message : String(err);
    stderr.write(`[smoke] fatal: ${e}\n`);
    await client.close().catch(() => undefined);
    await host.stop().catch(() => undefined);
    await new Promise<void>((r) => dump.end(r));
    exit(1);
  }

  await host.stop();
  await new Promise<void>((r) => dump.end(r));
  log(`[smoke] done — frames written to ${dumpPath}`);
}

function summarizeUpdate(p: SessionNotificationParams, log: (s: string) => void): void {
  const u = p.update;
  if (isMessageChunk(u)) {
    const text = u.content.type === "text" ? u.content.text : `<${u.content.type}>`;
    log(`[update] ${u.sessionUpdate}: ${text}`);
    return;
  }
  if (isToolCallStart(u)) {
    log(
      `[update] tool_call ${u.toolCallId} kind=${u.kind ?? "?"} status=${u.status ?? "?"} title=${JSON.stringify(u.title)}`,
    );
    return;
  }
  if (isToolCallProgress(u)) {
    log(
      `[update] tool_call_update ${u.toolCallId} status=${u.status ?? "?"}${
        u.title ? ` title=${JSON.stringify(u.title)}` : ""
      }`,
    );
    return;
  }
  log(`[update] (unmodeled) sessionUpdate=${u.sessionUpdate}`);
}

void main();
