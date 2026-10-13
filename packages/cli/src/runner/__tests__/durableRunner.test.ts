// Agent turns end to end on a real pi-durable harness and SQLite storage,
// with pi-ai's scripted faux provider standing in for the model.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import type { AgentCallRequest, AgentSpec, TurnSpec } from "@opencara/shared";
import { runAgentTurn, type TurnController, type TurnDeps } from "../durableRunner.js";

function device(responses: FauxResponseStep[]) {
  const dir = mkdtempSync(join(tmpdir(), "opencara-turn-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1", reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const deps: TurnDeps = {
    loadRuntime: async () => ({ models, defaultThinkingLevel: "off" }),
    conversationsDir: join(dir, "conversations"),
  };
  return { dir, faux, deps };
}

function spec(cwd: string, turn: Partial<TurnSpec> = {}): AgentSpec {
  return {
    kind: "test-agent",
    args: [],
    env: {},
    cwd,
    turn: {
      model: "faux/m1",
      systemPromptMd: "You are a test agent.",
      userPromptMd: "hello",
      history: [],
      images: [],
      ...turn,
    },
  };
}

function start(
  spec_: AgentSpec,
  deps: TurnDeps,
  onAgentCall: (req: AgentCallRequest, controller: TurnController) => void = () => {},
) {
  let stdout = "";
  let stderr = "";
  const handle = runAgentTurn({
    runId: randomUUID(),
    spec: spec_,
    handlers: {
      onLog: (stream, chunk) => {
        if (stream === "stdout") stdout += chunk;
        else stderr += chunk;
      },
      sendAgentCall: (req) => queueMicrotask(() => onAgentCall(req, handle.controller)),
    },
    deps,
  });
  return {
    handle,
    log: () => ({ stdout, stderr }),
    done: async () => ({ result: await handle.promise, stdout, stderr }),
  };
}

const userText = (messages: readonly Message[]) =>
  messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

describe("runAgentTurn", () => {
  it("runs tools, streams markers, and answers in a stored conversation", async () => {
    const { dir, deps } = device([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("all done"),
    ]);
    const { result, stdout } = await start(spec(dir), deps).done();
    assert.equal(result.status, "succeeded");
    assert.equal(result.exitCode, 0);
    assert.ok(existsSync(join(deps.conversationsDir, `${result.conversationId}.sqlite`)));
    assert.equal(stdout, "\n[tool] bash: echo hi\n\n[tool] bash: echo hi → completed\nall done");
  });

  it("continues the prior conversation without replaying the history", async () => {
    const seen: (readonly Message[])[] = [];
    const { dir, deps } = device([
      fauxAssistantMessage("first"),
      (context) => {
        seen.push(context.messages);
        return fauxAssistantMessage("second");
      },
    ]);
    const first = await start(spec(dir), deps).done();
    const second = await start(
      spec(dir, {
        userPromptMd: "again",
        priorConversationId: first.result.conversationId!,
        history: [{ role: "user", text: "REPLAYED" }],
      }),
      deps,
    ).done();
    assert.equal(second.result.status, "succeeded");
    assert.equal(second.result.conversationId, first.result.conversationId);
    const assistantTexts = seen[0]!.filter((m) => m.role === "assistant").map((m) => JSON.stringify(m.content));
    assert.ok(assistantTexts.some((t) => t.includes("first")), "the earlier answer is in context");
    assert.doesNotMatch(userText(seen[0]!), /REPLAYED/);
  });

  it("starts a new conversation seeded with the history when the prior one isn't stored here", async () => {
    const seen: (readonly Message[])[] = [];
    const { dir, deps } = device([
      (context) => {
        seen.push(context.messages);
        return fauxAssistantMessage("fresh");
      },
    ]);
    const prior = randomUUID();
    const { result, stderr } = await start(
      spec(dir, { priorConversationId: prior, history: [{ role: "assistant", text: "EARLIER ANSWER" }] }),
      deps,
    ).done();
    assert.equal(result.status, "succeeded");
    assert.notEqual(result.conversationId, prior);
    assert.match(userText(seen[0]!), /EARLIER ANSWER/);
    assert.match(stderr, /not on this device/);
  });

  it("appends the project instructions file to the agent's instructions", async () => {
    const seen: (readonly Message[])[] = [];
    const { dir, deps } = device([
      (context) => {
        seen.push(context.messages);
        return fauxAssistantMessage("ok");
      },
    ]);
    writeFileSync(join(dir, "AGENTS.md"), "Always answer in haiku.\n");
    await start(spec(dir, { instructionsFile: "AGENTS.md" }), deps).done();
    const system = JSON.stringify(seen[0]!.filter((m) => m.role === "system"));
    assert.match(system, /You are a test agent\./);
    assert.match(system, /Always answer in haiku\./);
  });

  it("serves the opencara tools through agent-call frames", async () => {
    const seen: (readonly Message[])[] = [];
    const sent: AgentCallRequest[] = [];
    const { dir, deps } = device([
      fauxAssistantMessage([fauxToolCall("opencara_issue_body_set", { issueNumber: 7, bodyMd: "new body" })], {
        stopReason: "toolUse",
      }),
      (context) => {
        seen.push(context.messages);
        return fauxAssistantMessage("could not update it");
      },
    ]);
    const { result, stdout } = await start(spec(dir), deps, (req, controller) => {
      sent.push(req);
      controller.onAgentCallResult({
        type: "agent-call-result",
        runId: req.runId,
        callId: req.callId,
        result: { ok: false, reason: "issue not in project" },
      });
    }).done();
    assert.equal(result.status, "succeeded");
    assert.equal(sent.length, 1);
    const call = sent[0]!;
    assert.equal(call.kind, "issue.body.set");
    assert.equal(call.kind === "issue.body.set" ? call.issueNumber : undefined, 7);
    const toolResult = seen[0]!.find((m) => m.role === "toolResult");
    assert.ok(toolResult && toolResult.isError, "the rejection reaches the model as an error result");
    assert.match(JSON.stringify(toolResult.content), /rejected: issue not in project/);
    assert.match(stdout, /\[tool\] opencara_issue_body_set .* → failed\n/);
  });

  it("fails a turn that ends without reply text", async () => {
    const { dir, deps } = device([fauxAssistantMessage(" ")]);
    const { result } = await start(spec(dir), deps).done();
    assert.equal(result.status, "failed");
    assert.match(result.errorMessage ?? "", /without any reply text/);
  });

  it("fails fast on a model this device doesn't provide, keeping only a stored conversation", async () => {
    const { dir, deps } = device([fauxAssistantMessage("first")]);
    const fresh = await start(spec(dir, { model: "faux/unknown" }), deps).done();
    assert.equal(fresh.result.status, "failed");
    assert.equal(fresh.result.conversationId, null);
    assert.match(fresh.result.errorMessage ?? "", /faux\/unknown is not available on this device/);

    const stored = (await start(spec(dir), deps).done()).result.conversationId!;
    const resumed = await start(spec(dir, { model: "faux/unknown", priorConversationId: stored }), deps).done();
    assert.equal(resumed.result.status, "failed");
    assert.equal(resumed.result.conversationId, stored);
  });

  it("creates no conversation for a turn cancelled before it starts", async () => {
    const { dir, deps } = device([]);
    const { promise: loading, resolve: finishLoading } = Promise.withResolvers<void>();
    const turn = start(spec(dir), {
      ...deps,
      loadRuntime: async (env, provider) => {
        await loading;
        return deps.loadRuntime(env, provider);
      },
    });
    turn.handle.controller.cancel();
    finishLoading();
    const { result } = await turn.done();
    assert.equal(result.status, "cancelled");
    assert.equal(result.conversationId, null);
    assert.equal(existsSync(deps.conversationsDir), false);
  });

  it("cancels a running turn, tool call included", async () => {
    const { dir, deps } = device([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], { stopReason: "toolUse" }),
    ]);
    const turn = start(spec(dir), deps);
    for (let i = 0; i < 200 && !turn.log().stdout.includes("sleep 30"); i++) await sleep(25);
    const t0 = Date.now();
    turn.handle.controller.cancel();
    const { result, stdout } = await turn.done();
    assert.equal(result.status, "cancelled");
    assert.ok(Date.now() - t0 < 10_000, "the sleeping tool call was aborted");
    assert.match(stdout, /\[tool\] bash: sleep 30 → failed\n/);
  });
});
