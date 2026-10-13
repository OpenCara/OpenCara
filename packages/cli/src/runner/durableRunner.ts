// Runs one agent turn in-process as a pi-durable conversation:
//   1. Pick the conversation: continue `turn.priorConversationId` when this
//      device stores it, else start a new one (seeded with the chat history).
//   2. Open its SQLite storage under a harness with the coding tools
//      (read / write / edit / bash in the job's cwd), the opencara tools and
//      pi's models (models.ts).
//   3. Configure the turn — model, thinking level, instructions (the
//      orchestrator's system prompt plus the project instructions file),
//      cwd — submit the message, and stream the conversation's events into
//      the job log (markers.ts) until the input settles.
// Work interrupted by a crash stays in the storage; the next turn that opens
// the conversation finishes it before answering.

import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness,
  section,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type UserInput,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  parseModelRef,
  type AgentCallRequest,
  type AgentCallResultMessage,
  type AgentSpec,
  type TurnSpec,
} from "@opencara/shared";
import { CONVERSATIONS_DIR } from "../config/paths.js";
import { lockConversation, pickConversation } from "./conversations.js";
import { resolveInstructionsFile } from "./instructionsFile.js";
import { createEventTranslator, type LogSink } from "./markers.js";
import { loadPiRuntime, type PiRuntime } from "./models.js";
import { AgentCallBridge, createOpencaraTools } from "./opencaraTools.js";

/** How long to wait for the settled turn's last events to reach the log. */
const LOG_DRAIN_MS = 5_000;

export interface TurnHandlers {
  onLog: LogSink;
  /** Send an opencara tool call to the orchestrator. */
  sendAgentCall: (req: AgentCallRequest) => void;
}

export interface TurnResult {
  status: "succeeded" | "failed" | "cancelled";
  exitCode: number;
  /** Conversation the turn ran in; null when it failed before one existed. */
  conversationId: string | null;
  errorMessage?: string;
}

export interface TurnController {
  /** Abort the turn. Idempotent; safe before the conversation exists. */
  cancel(): void;
  onAgentCallResult(msg: AgentCallResultMessage): void;
}

/** Seams for tests: where models come from and where conversations live. */
export interface TurnDeps {
  loadRuntime: (env: Record<string, string>, provider: string) => Promise<PiRuntime>;
  conversationsDir: string;
}

const DEFAULT_DEPS: TurnDeps = { loadRuntime: loadPiRuntime, conversationsDir: CONVERSATIONS_DIR };

/** System prompt sections every agent gets ahead of its own instructions. */
const Environment = defineExtension({
  name: "opencara-environment",
  sections: [
    section(
      "preamble",
      () =>
        "You are an agent run by OpenCara on the user's machine. Your tools read, write and " +
        "edit files and run shell commands in the working directory below. Nobody approves " +
        "tool calls or answers questions while you work: finish the task, then reply.",
      { tag: false },
    ),
    section("cwd", (input) => input.env?.cwd),
  ],
});

export function runAgentTurn(opts: {
  runId: string;
  spec: AgentSpec;
  handlers: TurnHandlers;
  deps?: TurnDeps;
}): { promise: Promise<TurnResult>; controller: TurnController } {
  const { runId, spec, handlers } = opts;
  const deps = opts.deps ?? DEFAULT_DEPS;
  const turn = spec.turn;
  if (!turn) throw new Error("runAgentTurn: spec.turn is required");
  const { onLog } = handlers;
  const ctx = BACKGROUND_CONTEXT;
  const bridge = new AgentCallBridge(runId, handlers.sendAgentCall);
  const translator = createEventTranslator(onLog, { captureThinking: turn.captureThinking });
  let cancelRequested = false;
  let conversation: Conversation | undefined;

  const abort = () => {
    conversation?.abort(ctx).catch((err: unknown) => {
      onLog("stderr", `[opencara] abort failed: ${errorText(err)}\n`);
    });
  };
  const controller: TurnController = {
    cancel() {
      if (cancelRequested) return;
      cancelRequested = true;
      abort();
    },
    onAgentCallResult(msg) {
      bridge.onResult(msg);
    },
  };

  const promise = (async (): Promise<TurnResult> => {
    const ref = parseModelRef(turn.model);
    if (!ref) return failed(null, `invalid model "${turn.model}" (expected <provider>/<modelId>)`);
    const slot = pickConversation(deps.conversationsDir, turn.priorConversationId);
    if (turn.priorConversationId !== undefined && !slot.resumed) {
      onLog(
        "stderr",
        `[opencara] conversation ${turn.priorConversationId} is not on this device; starting a new one\n`,
      );
    }
    const release = await lockConversation(slot.id);
    let harness: Harness | undefined;
    let events: AgentEventStream | undefined;
    try {
      const runtime = await deps.loadRuntime(spec.env, ref.provider);
      // Cancelled while loading: don't create a conversation for nothing.
      if (cancelRequested) return cancelled(slot.resumed ? slot.id : null);
      if (!runtime.models.getModel(ref.provider, ref.modelId)) {
        return failed(
          slot.resumed ? slot.id : null,
          `model ${turn.model} is not available on this device — \`pi --list-models\` lists ` +
            "the models its pi configuration provides",
        );
      }
      const cwd = spec.cwd ?? process.cwd();
      harness = await openHarness(slot.path, runtime.models, bridge, spec, cwd, deps, onLog);
      conversation = await harness.root(ctx);
      await conversation.configure(
        {
          model: ref,
          thinkingLevel: turn.thoughtLevel ?? runtime.defaultThinkingLevel,
          instructions: turnInstructions(turn, cwd, onLog),
          cwd,
        },
        ctx,
      );

      // A settled input's last events can trail `wait()`: hold the log open
      // until the listener has seen the settlement (bounded).
      const settledIds = new Set<unknown>();
      let onSettled = () => {};
      events = await watchEvents(harness, conversation.id, ctx);
      events.start(async (batch) => {
        for (const event of batch) {
          translator.handle(event);
          if (event.type !== "submission") continue;
          const { id, status } = event.record;
          if (status === "done" || status === "unanswered") {
            settledIds.add(id);
            onSettled();
          }
        }
      });

      if (cancelRequested) return cancelled(slot.id);
      const submission = await conversation.submit(
        { type: "input", content: turnInput(turn, !slot.resumed), requestId: runId },
        ctx,
      );
      // A cancel racing the admission may have found nothing to abort yet.
      if (cancelRequested) abort();
      const settled = await submission.wait(ctx);
      if (!settledIds.has(submission.id)) {
        const { promise: logged, resolve } = Promise.withResolvers<void>();
        onSettled = () => {
          if (settledIds.has(submission.id)) resolve();
        };
        await Promise.race([logged, sleep(LOG_DRAIN_MS, undefined, { ref: false })]);
      }

      if (cancelRequested) return cancelled(slot.id);
      if (settled.status === "unanswered") {
        const { detail } = settled;
        const suffix =
          detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
        return failed(slot.id, `turn ended unanswered (${settled.reason})${suffix}`);
      }
      // A dead turn must not pass for an answer: downstream it would post
      // an empty review section or hand nothing to the next flow node.
      if (!translator.sawText) return failed(slot.id, "turn ended without any reply text");
      return { status: "succeeded", exitCode: 0, conversationId: slot.id };
    } catch (err) {
      // Only claim a conversation that exists: one the harness opened, or
      // the resumed one.
      const conversationId = harness || slot.resumed ? slot.id : null;
      return cancelRequested ? cancelled(conversationId) : failed(conversationId, errorText(err));
    } finally {
      translator.flush();
      bridge.shutdown("turn ended");
      await events?.stop().catch(() => undefined);
      await harness?.close(ctx).catch((err: unknown) => {
        onLog("stderr", `[opencara] closing the conversation failed: ${errorText(err)}\n`);
      });
      release();
    }
  })();

  return { promise, controller };
}

async function openHarness(
  path: string,
  models: Models,
  bridge: AgentCallBridge,
  spec: AgentSpec,
  cwd: string,
  deps: TurnDeps,
  onLog: LogSink,
): Promise<Harness> {
  mkdirSync(deps.conversationsDir, { recursive: true, mode: 0o700 });
  const registry = createRegistry();
  registry.install(Environment);
  registry.install(CodingTools);
  registry.install(createOpencaraTools(bridge));
  // The agent's env (credentials, OPENCARA_* run context, GH_TOKEN) is what
  // its shell commands see, over the daemon's own environment.
  const shellEnv = { ...process.env, ...spec.env };
  return Harness.open(
    await openNodeSqliteStorage(path),
    {
      models,
      registry,
      env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd, shellEnv }),
      onReport: (err) => onLog("stderr", `[pi] ${errorText(err)}\n`),
    },
    BACKGROUND_CONTEXT,
  );
}

function turnInstructions(turn: TurnSpec, cwd: string, onLog: LogSink): string {
  const file = resolveInstructionsFile(cwd, turn.instructionsFile, onLog);
  if (!file) return turn.systemPromptMd;
  return `${turn.systemPromptMd.trim()}\n\n# Project instructions (${turn.instructionsFile})\n\n${file.content.trim()}`;
}

/** This turn's message: page context and (for a new conversation) the chat
 *  history ahead of the message itself, then the attached images. */
function turnInput(turn: TurnSpec, newConversation: boolean): UserInput {
  const parts: string[] = [];
  if (turn.pageContextJson?.trim()) {
    parts.push(`# Page context (JSON)\n\n\`\`\`json\n${turn.pageContextJson}\n\`\`\``);
  }
  if (newConversation && turn.history.length > 0) {
    parts.push(
      `# Conversation so far\n\n${turn.history.map((t) => `**${t.role}**: ${t.text}`).join("\n\n")}`,
    );
  }
  const text =
    parts.length === 0
      ? turn.userPromptMd
      : [...parts, `# Current message\n\n${turn.userPromptMd}`].join("\n\n---\n\n");
  if (turn.images.length === 0) return text;
  return [
    { type: "text", text },
    ...turn.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
  ];
}

function failed(conversationId: string | null, errorMessage: string): TurnResult {
  return { status: "failed", exitCode: 1, conversationId, errorMessage };
}

function cancelled(conversationId: string | null): TurnResult {
  return { status: "cancelled", exitCode: 1, conversationId };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
