import { Hono } from "hono";
import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "../../db/client.js";
import { agentRunLogs, agentRuns, agents, issues } from "../../db/schema.js";
import type { AgentDispatcher, LogStream } from "../../dispatch/dispatcher.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";

interface ChatRoutesDeps {
  db: Db;
  pg: Sql;
  dispatcher: AgentDispatcher;
}

interface PageContext {
  pathname?: string;
  projectId?: string;
  flowSlug?: string;
  flowRunId?: string;
  selectedNodeId?: string;
  /** Free-form payload pages can attach. Forwarded verbatim to the agent. */
  data?: Record<string, unknown>;
  /**
   * Set by the issue canvas page. When present, the server hydrates the
   * agent's stdin with the full local issue row (title, body, labels,
   * assignees) plus the user-selected snippet so the agent has stylistic
   * context for the rewrite.
   */
  canvas?: {
    kind: "issue";
    projectId: string;
    issueNumber: number;
    selection?: { text: string } | null;
  };
}

/**
 * Chat with a user-defined agent. Each turn spawns the agent's subprocess via
 * the existing dispatcher; stdin carries `{ message, pageContext, history? }`,
 * env carries OPENCARA_CHAT_* so the agent can use its own --resume / --continue
 * flag once turnIndex > 1.
 *
 * Returns immediately with the agentRunId; the panel SSE-tails
 * /api/runs/:agentRunId/logs/stream for the streamed reply.
 */
export function chatRoutes(deps: ChatRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  r.post("/chat/messages", auth, async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    const agentId = String(body.agentId ?? "");
    const sessionId = String(body.sessionId ?? "").trim();
    const turnIndex = Number.parseInt(String(body.turnIndex ?? "1"), 10);
    const message = typeof body.message === "string" ? body.message : "";
    const pageContext: PageContext =
      body.pageContext && typeof body.pageContext === "object"
        ? (body.pageContext as PageContext)
        : {};
    const history = Array.isArray(body.history) ? body.history : [];

    if (!agentId || !sessionId || !message.trim() || !Number.isFinite(turnIndex)) {
      return c.json(
        { error: "agentId, sessionId, turnIndex, and message are required" },
        400,
      );
    }

    const agent = await deps.db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.userId, user.id)),
    });
    if (!agent) return c.json({ error: "agent not found" }, 404);

    const env: Record<string, string> = {
      ...agent.env,
      OPENCARA_CHAT_SESSION_ID: sessionId,
      OPENCARA_CHAT_TURN_INDEX: String(turnIndex),
      OPENCARA_CHAT_PAGE_CONTEXT: JSON.stringify(pageContext),
    };

    const spec = {
      kind: agent.name,
      command: agent.command,
      args: agent.args,
      env,
      cwd: agent.cwd ?? undefined,
    };
    const agentRunId = ulid();
    const projectId = pageContext.projectId ?? null;
    await deps.db.insert(agentRuns).values({
      id: agentRunId,
      spec,
      status: "running",
      projectId,
      flowRunStepId: null,
      startedAt: new Date(),
    });

    let seq = 0;
    const onLog = (stream: LogStream, chunk: string) => {
      const mySeq = seq++;
      void deps.db
        .insert(agentRunLogs)
        .values({ agentRunId, seq: mySeq, stream, chunk })
        .then(() => deps.pg.notify("agent_run_logs", agentRunId))
        .catch((err: unknown) => {
          console.error("[chat] log persist failed", err);
        });
    };

    // Hydrate canvas-mode stdin with the full local issue row so the agent
    // has surrounding context (title, body, labels, assignees) — the
    // selection alone is too narrow for stylistic rewrites.
    let canvasIssue:
      | {
          number: number;
          title: string;
          bodyMd: string | null;
          labels: { name: string; color: string }[];
          assignees: { login: string; id: number }[];
          state: string;
          htmlUrl: string;
        }
      | null = null;
    if (pageContext.canvas?.kind === "issue") {
      const row = await deps.db.query.issues.findFirst({
        where: and(
          eq(issues.projectId, pageContext.canvas.projectId),
          eq(issues.number, pageContext.canvas.issueNumber),
        ),
      });
      if (row) {
        canvasIssue = {
          number: row.number,
          title: row.title,
          bodyMd: row.bodyMd,
          labels: row.labels,
          assignees: row.assignees,
          state: row.state,
          htmlUrl: row.htmlUrl,
        };
      }
    }
    const stdinJson: Record<string, unknown> = { message, pageContext, history };
    if (canvasIssue) stdinJson["issue"] = canvasIssue;
    if (pageContext.canvas?.selection) {
      stdinJson["selection"] = pageContext.canvas.selection;
    }

    // Fire-and-forget the dispatcher; the SSE stream is the client's only view.
    void (async () => {
      try {
        const result = await deps.dispatcher.run(spec, {
          stdinJson,
          onLog,
          hostId: agent.hostId,
        });
        await deps.db
          .update(agentRuns)
          .set({
            status: result.exitCode === 0 ? "succeeded" : "failed",
            exitCode: result.exitCode,
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, agentRunId));
      } catch (err) {
        console.error("[chat] dispatcher run failed", err);
        await deps.db
          .update(agentRuns)
          .set({ status: "failed", finishedAt: new Date() })
          .where(eq(agentRuns.id, agentRunId));
      }
      // Trigger one final SSE flush so the panel sees terminal state.
      void deps.pg.notify("agent_run_logs", agentRunId);
    })();

    return c.json({ agentRunId, sessionId, turnIndex });
  });

  return r;
}
