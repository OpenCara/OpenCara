import { and, eq, inArray } from "drizzle-orm";
import {
  agentRuns,
  flowRuns,
  flowRunSteps,
  flows,
} from "../../db/schema.js";
import type { PageSkillBuilder } from "../skills.js";

/**
 * Flow run detail page (apps/web/src/pages/FlowRunDetailPage.tsx). Pure
 * read-only — re-runs and cancels still go through the UI. The builder
 * mirrors the snapshot the SSE stream sends to the page so the agent
 * sees exactly what the user sees.
 */
export const flowRunDetailBuilder: PageSkillBuilder = async (ctx) => {
  const projectId = ctx.pageContext.projectId;
  const runId = ctx.pageContext.flowRunId;
  if (!projectId || !runId) return null;

  const run = await ctx.db.query.flowRuns.findFirst({
    where: and(eq(flowRuns.id, runId), eq(flowRuns.projectId, projectId)),
  });
  if (!run) return null;

  const flow = await ctx.db.query.flows.findFirst({
    where: eq(flows.id, run.flowId),
  });

  const steps = await ctx.db.query.flowRunSteps.findMany({
    where: eq(flowRunSteps.flowRunId, run.id),
    orderBy: [flowRunSteps.idx],
  });
  const stepIds = steps.map((s) => s.id);
  const linkedAgentRuns = stepIds.length
    ? await ctx.db.query.agentRuns.findMany({
        where: inArray(agentRuns.flowRunStepId, stepIds),
      })
    : [];

  const baseUrl = ctx.baseUrl.replace(/\/$/, "");
  const instructions = `# Skill: opencara-flow-run-inspector

You are looking at a single run of the flow \`${flow?.slug ?? "(unknown)"}\`
(run id \`${run.id}\`, status \`${run.status}\`). This skill is **read-only**
— it exposes no \`opencara-call\` kinds.

Hydrated stdin keys:

- \`run\` — the flow run row (id, status, createdAt, finishedAt, etc.).
- \`flow\` — the flow this run belongs to.
- \`steps\` — every flow_run_step ordered by \`idx\` (status, started/finished
  timestamps, output summary).
- \`agentRuns\` — every agent_run linked to one of those steps.

If the user wants to rerun or cancel, point them at the rerun button on
this page; don't emit \`opencara-call\` blocks.
`;

  return {
    skill: {
      name: "opencara-flow-run-inspector",
      instructions,
      baseUrl,
      runId: ctx.runId,
    },
    hydrated: {
      run,
      flow: flow ?? null,
      steps,
      agentRuns: linkedAgentRuns,
    },
    projectScope: projectId,
  };
};
