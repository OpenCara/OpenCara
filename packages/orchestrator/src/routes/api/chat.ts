import { Hono } from "hono";
import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";
import type { Sql } from "postgres";
import type { AcpHistoryTurn, AgentSpec } from "@opencara/shared";
import type { Db } from "../../db/client.js";
import { agentRunLogs, agentRuns, agents, chatSessions } from "../../db/schema.js";
import type { AgentDispatcher, LogStream } from "../../dispatch/dispatcher.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { loadOwnedProject } from "../../auth/ownership.js";
import { resolvePageSkill, type PageContextLike } from "../../flows/skills.js";
import {
  buildAcpSpec,
  checkAcpEligibility,
} from "../../agents/acp-gate.js";

interface ChatRoutesDeps {
  db: Db;
  pg: Sql;
  dispatcher: AgentDispatcher;
  publicBaseUrl: string;
}

type PageContext = PageContextLike;

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

    // Resume continuity: a prior turn on this thread (same user, same
    // threadKey) wrote `acpSessionId` + `acpSessionHostId` after a
    // successful dispatch. If the user hasn't switched agent since, we
    // pass that id as `priorSessionId` so the shim runs `session/load`
    // (claude `--resume <uuid>`) and the model sees its prior turns
    // straight from the on-disk JSONL — no history bake-in needed.
    //
    // Mismatched agentId means the user picked a different agent
    // (chatSessions.ts POST clears acpSessionId when that happens, but
    // races between the agent-pick PATCH and an in-flight message are
    // possible). Drop priorSessionId rather than feed a foreign UUID
    // into the new shim.
    const chatRow = await deps.db.query.chatSessions.findFirst({
      where: and(
        eq(chatSessions.userId, user.id),
        eq(chatSessions.threadKey, sessionId),
      ),
    });
    const priorSessionId =
      chatRow?.acpSessionId &&
      chatRow.agentId === agentId &&
      chatRow.acpSessionId.length > 0
        ? chatRow.acpSessionId
        : undefined;
    // Pin to the device that holds this session's JSONL. Falls back to
    // the agent's own hostId (and then to any idle host) when this is
    // turn 1 or the prior host record was cleared.
    const dispatchHostId =
      (priorSessionId ? chatRow?.acpSessionHostId : null) ?? agent.hostId;

    const agentRunId = ulid();

    // Resolve the per-page skill. Builders for the active page hydrate
    // server-side data + emit the skill markdown that tells the agent
    // what opencara-call kinds are available here. Builders may also
    // refuse the request (canvas project not accessible, etc.) — we
    // surface that as 403 BEFORE inserting any state, mirroring the
    // earlier hand-rolled gate.
    const skillResult = await resolvePageSkill({
      pageContext,
      user: { id: user.id },
      baseUrl: deps.publicBaseUrl,
      runId: agentRunId,
      db: deps.db,
    });
    if (skillResult?.authError) {
      return c.json({ error: skillResult.authError }, 403);
    }

    // Project scope for agent-call gating. Builders that support
    // mutations return projectScope explicitly; other paths fall back
    // to the page's projectId (or null for legacy pages without one).
    // Re-verify ownership here — resolvePageSkill may authorize the
    // builder, but a stale pageContext.projectId from a foreign tab
    // would otherwise sneak through and tag this run with someone
    // else's project.
    //
    // Foreign or stale scopes drop to null rather than 403'ing: the chat
    // panel is reachable from non-project pages with no scope at all, so
    // null is already a supported mode. The run is logged unscoped, the
    // creator can still SSE-tail it (addedByUserId fallback in runs.ts),
    // and agent-call gating refuses cross-project mutations because the
    // run carries no projectId for the call site to check against.
    const projectIdCandidate =
      skillResult?.projectScope ?? pageContext.projectId ?? null;
    const projectId = projectIdCandidate
      ? (await loadOwnedProject(deps.db, projectIdCandidate, user.id))
          ? projectIdCandidate
          : null
      : null;

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

    // ACP eligibility — every supported kind dispatches via ACP. An
    // unsupported kind (e.g. legacy `custom` rows from before #30) gets
    // a 400 with a clear conversion hint, rather than the stale legacy
    // path's silent fallthrough.
    const eligibility = checkAcpEligibility(agent.kind);
    if (eligibility.refuseReason) {
      return c.json({ error: eligibility.refuseReason }, 400);
    }

    const spec: AgentSpec = buildAcpSpec({
      agent,
      env,
      systemPromptMd:
        skillResult?.skill.instructions ??
        "You are an opencara chat agent. Respond to the user's message about the current page.",
      userPromptMd: message,
      history: normalizeHistory(history),
      pageContext: pageContext as Record<string, unknown>,
      priorSessionId,
    });
    await deps.db.insert(agentRuns).values({
      id: agentRunId,
      spec,
      status: "running",
      projectId,
      flowRunStepId: null,
      // Direct attribution: chat panels on non-project pages persist with
      // projectId=null, and the run-log gate would otherwise 404 the
      // SSE stream the panel is tailing. With addedByUserId set, the
      // creator can read their own run regardless of project scope.
      addedByUserId: user.id,
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

    // Fire-and-forget the dispatcher; the SSE stream is the client's only view.
    void (async () => {
      try {
        const result = await deps.dispatcher.run(spec, {
          onLog,
          hostId: dispatchHostId,
          projectId,
          userId: user.id,
          sessionId,
        });
        await deps.db
          .update(agentRuns)
          .set({
            status: result.exitCode === 0 ? "succeeded" : "failed",
            exitCode: result.exitCode,
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, agentRunId));
        // Persist the session id the shim ran under, so the next turn
        // can resume via `priorSessionId`. Gated on (a) the run actually
        // succeeded — a failed run may have left the JSONL in a state
        // that --resume can't recover from cleanly, and (b) the chat
        // row still points at the SAME agent that ran this turn. If
        // the user switched agent mid-flight (chatSessions.ts cleared
        // acpSessionId on the POST), respect their choice instead of
        // silently re-pinning the row to the now-superseded agent.
        if (result.exitCode === 0 && result.acpSessionId) {
          await deps.db
            .update(chatSessions)
            .set({
              acpSessionId: result.acpSessionId,
              acpSessionHostId: result.agentHostId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatSessions.userId, user.id),
                eq(chatSessions.threadKey, sessionId),
                eq(chatSessions.agentId, agentId),
              ),
            );
        }
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

  /**
   * Inspect-only resolution of the active page skill. The chat panel uses
   * this to render a "what does the agent know about this page" drawer
   * without dispatching a run. We send back the markdown + the names of
   * hydrated stdin keys (NOT the values — those can be large and may
   * contain user data the panel already has via React Query).
   *
   * No agent_runs row, no dispatcher invocation, no DB write — just runs
   * the same registry resolution chat/messages would.
   */
  r.post("/chat/skill", auth, async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    const pageContext: PageContext =
      body.pageContext && typeof body.pageContext === "object"
        ? (body.pageContext as PageContext)
        : {};

    const resolved = await resolvePageSkill({
      pageContext,
      user: { id: user.id },
      baseUrl: deps.publicBaseUrl,
      // Fixed sentinel — this is an inspect call, not a real run.
      runId: "inspect",
      db: deps.db,
    });
    if (!resolved) return c.json({ skill: null });
    if (resolved.authError) {
      return c.json({ error: resolved.authError }, 403);
    }
    // Strip the project scope if the caller doesn't actually own the
    // project — keeps the panel from rendering "we know about project X"
    // for a foreign project id that snuck through pageContext.
    const projectScope = resolved.projectScope
      ? (await loadOwnedProject(deps.db, resolved.projectScope, user.id))
          ? resolved.projectScope
          : null
      : null;
    return c.json({
      skill: {
        name: resolved.skill.name,
        instructions: resolved.skill.instructions,
      },
      hydratedKeys: Object.keys(resolved.hydrated),
      projectScope,
    });
  });

  return r;
}

/**
 * Coerce the chat panel's free-form history payload into the strict
 * `AcpHistoryTurn[]` shape. The panel sends `{role, text}` tuples but
 * may include other fields we don't care about; we just keep the two
 * we need and drop anything that doesn't have a recognized role.
 */
function normalizeHistory(history: unknown[]): AcpHistoryTurn[] {
  const out: AcpHistoryTurn[] = [];
  for (const raw of history) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { role?: unknown; text?: unknown };
    if (r.role !== "user" && r.role !== "assistant") continue;
    if (typeof r.text !== "string") continue;
    out.push({ role: r.role, text: r.text });
  }
  return out;
}
