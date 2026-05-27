import { and, desc, eq, inArray } from "drizzle-orm";
import {
  agentRuns,
  agents,
  flowRuns,
  flowRunSteps,
  flows,
} from "../../db/schema.js";
import type { PageSkillBuilder } from "../skills.js";

/**
 * Steering chat anchored to a single agent node in a flow run. The chat
 * panel embedded in FlowRunDetailPage.tsx points here whenever the user
 * picks an agent node — pageContext.flowRunStepId selects the row.
 *
 * The chat session's `acpSessionId` (seeded from the same step in
 * chatSessions.ts:hydrateFromFlowRunStep) makes the user's next message
 * resume the flow agent's conversation. The agent sees a turn that says
 * "the user wants you to adjust your approach"; with `claude --resume`
 * (or the equivalent for other adapters) it picks up the prior context
 * and applies the steering input.
 *
 * Mid-run vs post-run: when the flow agent is still running, its JSONL
 * is being written by a process the chat dispatcher can't race against.
 * The chat dispatch is queued on the same pinned device, but
 * `claude --resume` can't open a file another instance has open. In
 * practice the steering message lands once the current node finishes
 * its turn — the panel will surface that the agent is busy and the
 * message will be replayed when the session frees up. (UI loop: send
 * → 500 from claude --resume → SSE error → user retries.) Cleaner
 * mid-run interruption is future work.
 */
export const flowRunStepChatBuilder: PageSkillBuilder = async (ctx) => {
  const stepId = ctx.pageContext.flowRunStepId;
  const projectId = ctx.pageContext.projectId;
  if (!stepId || !projectId) return null;

  const step = await ctx.db.query.flowRunSteps.findFirst({
    where: eq(flowRunSteps.id, stepId),
  });
  if (!step) return null;

  const run = await ctx.db.query.flowRuns.findFirst({
    where: and(eq(flowRuns.id, step.flowRunId), eq(flowRuns.projectId, projectId)),
  });
  if (!run) return null;

  const flow = await ctx.db.query.flows.findFirst({
    where: eq(flows.id, run.flowId),
  });

  const stepAgentRuns = await ctx.db.query.agentRuns.findMany({
    where: eq(agentRuns.flowRunStepId, step.id),
    orderBy: [desc(agentRuns.createdAt)],
    limit: 5,
  });

  // Look up the agent name for the most-recent run on this step, when
  // possible. `agent_runs.spec` carries the kind/command, not the user
  // agent's id; but `agents.name` is what the user sees in the UI, so
  // we expose it in the skill markdown for context.
  const userAgentIds = stepAgentRuns
    .map((r) => {
      const env = ((r.spec as { env?: Record<string, unknown> } | null)?.env ?? {}) as Record<
        string,
        unknown
      >;
      const id = typeof env.OPENCARA_AGENT_ID === "string" ? env.OPENCARA_AGENT_ID : null;
      return id;
    })
    .filter((id): id is string => !!id);
  const userAgents =
    userAgentIds.length > 0
      ? await ctx.db.query.agents.findMany({
          where: inArray(agents.id, userAgentIds),
        })
      : [];
  const lastAgent = userAgents[0] ?? null;

  const baseUrl = ctx.baseUrl.replace(/\/$/, "");
  const instructions = `# Skill: opencara-steering-chat

You are receiving a **steering message** from the user about one node of a
running (or recently-completed) flow.

Context:

- **Flow:** \`${flow?.slug ?? "(unknown)"}\` (run id \`${run.id}\`, status \`${run.status}\`).
- **Node:** \`${step.nodeId}\` (\`${step.nodeKind}\`, idx ${step.idx}, status \`${step.status}\`).
- **Agent that ran this node:** ${lastAgent ? `\`${lastAgent.name}\`` : "(unknown)"}.

The chat session is configured to **resume the agent's ACP session**, so
when you respond you have the full conversation context the flow agent
saw — prior tool calls, intermediate plans, and the output it produced.

What "steering" means here:

1. **The user is correcting course** ("skip the tests for now and focus on
   the API layer"). Take the new instructions as higher priority than the
   prior plan and proceed accordingly.
2. **The user is asking about state** ("what file are you editing?",
   "what's blocking you?"). Answer from the conversation context, briefly.
3. **The user wants a different approach** ("revert that change and try X
   instead"). Discard the prior plan and start the new approach.

This skill exposes no MCP tools. If the node is an issue-implement-style
agent with a worktree, you can keep using the same \`gh\`, \`git\`, and
shell tools you had during the flow run — \`GH_TOKEN\` is injected per
turn the same way.

Hydrated stdin keys:

- \`flowRun\` — the flow_run row.
- \`flow\` — the flow this run belongs to.
- \`step\` — the flow_run_step the chat is anchored to.
- \`agentRuns\` — recent agent_run rows for this step (status, host, exit).
- \`agent\` — the user agent row that ran this step (name, kind), if known.
`;

  return {
    skill: {
      name: "opencara-steering-chat",
      instructions,
      baseUrl,
      runId: ctx.runId,
    },
    hydrated: {
      flowRun: run,
      flow: flow ?? null,
      step,
      agentRuns: stepAgentRuns,
      agent: lastAgent
        ? { id: lastAgent.id, name: lastAgent.name, kind: lastAgent.kind }
        : null,
    },
    projectScope: projectId,
  };
};
