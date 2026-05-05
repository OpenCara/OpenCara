import { Hono } from "hono";
import { ulid } from "ulid";
import { and, eq, isNull } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "../../db/client.js";
import { agentRunLogs, agentRuns, agents, issues, projects } from "../../db/schema.js";
import type { AgentDispatcher, LogStream } from "../../dispatch/dispatcher.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { buildIssueCanvasSkill } from "../../flows/skills.js";

interface ChatRoutesDeps {
  db: Db;
  pg: Sql;
  dispatcher: AgentDispatcher;
  publicBaseUrl: string;
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

    // Validate the canvas project scope BEFORE we insert any state — the
    // dispatcher will use this projectId to gate agent-call mutations, so
    // accepting an arbitrary client-supplied id would let a logged-in user
    // mutate any project's drafts. Match the existing GET /projects/:id
    // posture: project must exist + not be soft-deleted.
    if (pageContext.canvas?.kind === "issue") {
      const proj = await deps.db.query.projects.findFirst({
        where: and(
          eq(projects.id, pageContext.canvas.projectId),
          isNull(projects.removedAt),
        ),
      });
      if (!proj) return c.json({ error: "canvas project not accessible" }, 403);
    }

    const agentRunId = ulid();
    const projectId = pageContext.projectId ?? null;

    // Build the full env + spec BEFORE the agent_runs insert so the
    // persisted spec includes everything the agent will actually see.
    // Earlier this stored env={} to avoid leaking the per-run token; that
    // token is gone now and the audit/debug/retry workflows want the real
    // env captured at dispatch time.
    const env: Record<string, string> = {
      ...agent.env,
      OPENCARA_CHAT_SESSION_ID: sessionId,
      OPENCARA_CHAT_TURN_INDEX: String(turnIndex),
      OPENCARA_CHAT_PAGE_CONTEXT: JSON.stringify(pageContext),
      OPENCARA_AGENT_RUN_ID: agentRunId,
    };
    const spec = {
      kind: agent.name,
      command: agent.command,
      args: agent.args,
      env,
      cwd: agent.cwd ?? undefined,
    };
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
          isNull(issues.removedAt),
        ),
      });
      if (row) {
        canvasIssue = {
          number: row.number,
          title: row.title,
          // Hand the agent the CURRENTLY VISIBLE body — i.e. the unsaved
          // draft if one exists, otherwise the GitHub-mirrored body. If
          // we sent row.bodyMd unconditionally, the agent would rewrite a
          // stale base and overwrite the user's in-progress draft on save.
          bodyMd: row.draftBodyMd ?? row.bodyMd,
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
    if (pageContext.canvas?.kind === "issue") {
      stdinJson["skill"] = buildIssueCanvasSkill({
        baseUrl: deps.publicBaseUrl,
        projectId: pageContext.canvas.projectId,
        issueNumber: pageContext.canvas.issueNumber,
        runId: agentRunId,
      });
    }

    // Fire-and-forget the dispatcher; the SSE stream is the client's only view.
    void (async () => {
      try {
        const result = await deps.dispatcher.run(spec, {
          stdinJson,
          onLog,
          hostId: agent.hostId,
          // Scopes agent-call mutations to this project. Canvas-mode
          // chats always set pageContext.canvas.projectId; non-canvas
          // chats use the page's projectId (read-only flows aren't
          // gated by this either way).
          projectId: pageContext.canvas?.projectId ?? projectId,
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
