import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import type { Sql } from "postgres";
import { FlowDefinitionSchema, type FlowDefinition, type FlowNode } from "@openkira/flows";
import type { Db } from "../db/client.js";
import {
  flowRuns,
  flowRunSteps,
  flows,
  githubInstallations,
  projects,
} from "../db/schema.js";
import type { AgentDispatcher } from "../dispatch/dispatcher.js";
import type { GithubAppClient } from "../github/app.js";
import { buildPullRequestContext } from "./context.js";
import {
  actionRunner,
  agentRunner,
  triggerRunner,
  SkipFlowError,
  type NodeRunCtx,
} from "./nodeRunners.js";

export interface PlatformEventInput {
  id: string;
  type: string;
  projectId: string | null;
  payload: unknown;
}

export interface FlowEngineDeps {
  db: Db;
  pg: Sql;
  app: GithubAppClient;
  dispatcher: AgentDispatcher;
}

export class FlowEngine {
  constructor(private deps: FlowEngineDeps) {}

  /** Fire-and-forget: webhook caller should NOT await this. */
  onPlatformEvent(event: PlatformEventInput): void {
    if (!event.projectId) return;
    setImmediate(() => {
      this.dispatchEvent(event).catch((err) => {
        console.error("[flow-engine] dispatch error", { eventId: event.id, err });
      });
    });
  }

  private async dispatchEvent(event: PlatformEventInput): Promise<void> {
    const projectFlows = await this.deps.db.query.flows.findMany({
      where: eq(flows.projectId, event.projectId!),
    });
    for (const row of projectFlows) {
      if (!row.enabled) continue;
      let def: FlowDefinition;
      try {
        const graph = row.graphJson as {
          nodes: unknown;
          edges: unknown;
          description?: string;
        };
        def = FlowDefinitionSchema.parse({
          slug: row.slug,
          name: row.name,
          description: graph.description ?? "",
          nodes: graph.nodes,
          edges: graph.edges,
        });
      } catch (err) {
        console.error("[flow-engine] invalid flow graph", { flowId: row.id, err });
        continue;
      }

      try {
        await this.runFlow(row.id, def, event);
      } catch (err) {
        console.error("[flow-engine] runFlow failed", { flowId: row.id, err });
      }
    }
  }

  private async runFlow(
    flowId: string,
    def: FlowDefinition,
    event: PlatformEventInput,
  ): Promise<void> {
    // Project + installation lookup
    const project = await this.deps.db.query.projects.findFirst({
      where: eq(projects.id, event.projectId!),
    });
    if (!project) return;
    const installation = await this.deps.db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, project.installationId),
    });
    if (!installation) return;

    const flowRunId = ulid();
    await this.deps.db.insert(flowRuns).values({
      id: flowRunId,
      flowId,
      projectId: project.id,
      triggerEventId: event.id,
      status: "running",
      startedAt: new Date(),
    });

    // Pre-build PR context once if it's a pull_request event (cheap optimization;
    // avoids re-fetching the diff for every agent node in the chain).
    let prContext;
    if (event.type === "pull_request") {
      try {
        prContext = await buildPullRequestContext(
          this.deps.app,
          installation,
          project,
          event.payload as never,
        );
      } catch (err) {
        console.error("[flow-engine] pr context fetch failed", err);
      }
    }

    let previousOutput: string | undefined;
    let nodeIdx = 0;
    let failed = false;
    let errorMsg: string | undefined;
    let skipped = false;

    for (const node of def.nodes) {
      const stepId = ulid();
      await this.deps.db.insert(flowRunSteps).values({
        id: stepId,
        flowRunId,
        nodeId: node.id,
        nodeKind: node.kind,
        idx: nodeIdx,
        status: "running",
        startedAt: new Date(),
      });

      const baseCtx: NodeRunCtx = {
        db: this.deps.db,
        pg: this.deps.pg,
        app: this.deps.app,
        dispatcher: this.deps.dispatcher,
        flowId,
        flowRunId,
        flowRunStepId: stepId,
        projectId: project.id,
        installation: {
          id: installation.id,
          githubInstallationId: installation.githubInstallationId,
        },
        project: { owner: project.owner, name: project.name },
        event,
        prContext,
        previousOutput,
      };

      try {
        let result;
        if (node.kind === "github.pull_request") {
          result = await triggerRunner(baseCtx, node);
        } else if (node.kind === "agent") {
          result = await agentRunner(baseCtx, node);
        } else {
          result = await actionRunner(baseCtx, node as never);
        }

        await this.deps.db
          .update(flowRunSteps)
          .set({
            status: "succeeded",
            outputJson: (result.output ?? null) as object | null,
            finishedAt: new Date(),
          })
          .where(eq(flowRunSteps.id, stepId));

        if (result.stdoutCaptured !== undefined) {
          previousOutput = result.stdoutCaptured;
        }
      } catch (err) {
        if (err instanceof SkipFlowError) {
          await this.deps.db
            .update(flowRunSteps)
            .set({ status: "skipped", finishedAt: new Date(), error: err.message })
            .where(eq(flowRunSteps.id, stepId));
          skipped = true;
          break;
        }
        const message = err instanceof Error ? err.message : String(err);
        await this.deps.db
          .update(flowRunSteps)
          .set({ status: "failed", finishedAt: new Date(), error: message })
          .where(eq(flowRunSteps.id, stepId));
        failed = true;
        errorMsg = message;
        break;
      }

      nodeIdx++;
    }

    await this.deps.db
      .update(flowRuns)
      .set({
        status: failed ? "failed" : skipped ? "cancelled" : "succeeded",
        finishedAt: new Date(),
        error: errorMsg,
      })
      .where(eq(flowRuns.id, flowRunId));
  }
}

export type { FlowNode };
