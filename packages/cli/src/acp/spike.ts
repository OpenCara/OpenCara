// ACP client spike harness.
//
// Drives `AcpClient` against a real ACP-speaking agent binary on the local
// machine and dumps every JSON-RPC frame to disk so we can read out what the
// wire actually looks like — answering the verification matrix in
// docs/acp-spike-findings.md.
//
// Usage:
//   pnpm --filter opencara acp:spike "summarize the current dir"
//   OR via tsx for ad-hoc tweaks:
//   tsx packages/cli/src/acp/spike.ts "summarize the current dir"
//
// Override the agent binary with env vars (defaults target Gemini CLI's
// experimental ACP entrypoint — verify the flag in your installed version):
//   OPENCARA_ACP_COMMAND=gemini
//   OPENCARA_ACP_ARGS='--experimental-acp'   (space-separated; quotes preserved)
//   OPENCARA_ACP_CWD=/path/to/run/in
//
// Auth flows through the agent binary's normal env (e.g. GEMINI_API_KEY for
// Gemini, ANTHROPIC_API_KEY for the Claude adapter) — the spike doesn't
// inject anything beyond what's already in process.env.

import { mkdirSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { argv, cwd, env, exit, stderr, stdout } from "node:process";
import { AcpClient } from "./client.js";
import type { TraceDirection } from "./client.js";
import {
  ACP_PROTOCOL_VERSION,
  isMessageChunk,
  isToolCallStart,
  isToolCallProgress,
  type SessionNotificationParams,
} from "./types.js";
import type { JsonRpcMessage } from "./jsonrpc.js";

interface CliArgs {
  prompt: string;
  command: string;
  args: string[];
  workdir: string;
  dumpDir: string;
}

function parseArgs(): CliArgs {
  const userArgs = argv.slice(2);
  if (userArgs.length === 0) {
    stderr.write("usage: spike.ts \"<prompt>\"\n");
    exit(2);
  }
  const prompt = userArgs.join(" ");
  const command = env["OPENCARA_ACP_COMMAND"] ?? "gemini";
  const argsString = env["OPENCARA_ACP_ARGS"] ?? "--acp";
  const args = argsString.length > 0 ? argsString.split(/\s+/).filter(Boolean) : [];
  const workdir = env["OPENCARA_ACP_CWD"] ?? cwd();
  const dumpDir = env["OPENCARA_ACP_DUMP_DIR"] ?? resolve(workdir, ".opencara-acp-spike");
  return { prompt, command, args, workdir, dumpDir };
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

  log(`[spike] command:  ${cli.command} ${cli.args.join(" ")}`);
  log(`[spike] cwd:      ${cli.workdir}`);
  log(`[spike] dump:     ${dumpPath}`);
  log(`[spike] prompt:   ${cli.prompt}`);
  log("");

  const client = new AcpClient({
    command: cli.command,
    args: cli.args,
    cwd: cli.workdir,
    trace: true,
  });

  client.onFrame((dir: TraceDirection, msg: JsonRpcMessage) => {
    dump.write(JSON.stringify({ dir, t: Date.now(), msg }) + "\n");
  });
  client.onStderr((chunk) => {
    stderr.write(`[stderr] ${chunk.endsWith("\n") ? chunk : chunk + "\n"}`);
  });
  client.onMalformed((line) => {
    log(`[malformed] ${line}`);
  });
  client.onSessionUpdate((p: SessionNotificationParams) => {
    summarizeUpdate(p, log);
  });

  client.start();

  try {
    log("[spike] → initialize");
    const init = await client.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Advertise no client capabilities. Well-behaved agents will avoid
      // requesting fs / terminal / permissions; misbehaving ones get a
      // method-not-found error from the connection's default handler.
      clientCapabilities: {},
    });
    log(`[spike] ← initialize protocolVersion=${init.protocolVersion}`);
    log(`[spike]   agentCapabilities=${JSON.stringify(init.agentCapabilities ?? {})}`);

    log("[spike] → session/new");
    const session = await client.newSession({
      cwd: cli.workdir,
      mcpServers: [], // No MCP servers in the client spike; that's #28.
    });
    log(`[spike] ← session/new sessionId=${session.sessionId}`);

    log("[spike] → session/prompt");
    const t0 = Date.now();
    const result = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: cli.prompt }],
    });
    const dt = Date.now() - t0;
    log(`[spike] ← session/prompt stopReason=${result.stopReason} elapsedMs=${dt}`);

    log("[spike] closing…");
    const exitInfo = await client.close();
    log(`[spike] child exit code=${exitInfo.code} signal=${exitInfo.signal ?? "none"}`);
  } catch (err) {
    const e = err instanceof Error ? err.message : String(err);
    stderr.write(`[spike] fatal: ${e}\n`);
    await client.close().catch(() => undefined);
    // dump.end() is async — await the flush so the last frames don't get
    // lost when we exit immediately after.
    await new Promise<void>((resolve) => dump.end(resolve));
    exit(1);
  }

  await new Promise<void>((resolve) => dump.end(resolve));
  log(`[spike] done — frames written to ${dumpPath}`);
}

function summarizeUpdate(
  p: SessionNotificationParams,
  log: (s: string) => void,
): void {
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
  // Unknown variant — print the discriminator so we can extend types.ts.
  log(`[update] (unmodeled) sessionUpdate=${u.sessionUpdate}`);
}

void main();
