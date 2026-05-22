import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Sql } from "postgres";
import type { AcpHistoryTurn, AcpPermissionMode, AgentSpec } from "@opencara/shared";
import type { Db } from "../../db/client.js";
import {
  agentRunLogs,
  agentRuns,
  agents,
  chatSessions,
  githubInstallations,
  projects,
} from "../../db/schema.js";
import type { AgentDispatcher, LogStream } from "../../dispatch/dispatcher.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { loadOwnedProject } from "../../auth/ownership.js";
import { resolvePageSkill, type PageContextLike } from "../../flows/skills.js";
import {
  buildAcpSpec,
  checkAcpEligibility,
} from "../../agents/acp-gate.js";
import type { GithubAppClient } from "../../github/app.js";

interface ChatRoutesDeps {
  db: Db;
  pg: Sql;
  dispatcher: AgentDispatcher;
  /**
   * GitHub App client, present when the orchestrator is configured with App
   * credentials. Used here to mint per-turn installation tokens that the
   * chat agent uses for `gh` shell commands (issue create/close/comment/labels).
   */
  app?: GithubAppClient;
  publicBaseUrl: string;
}

type PageContext = PageContextLike;

/**
 * Phrases the assistant emits when it has decided an opencara MCP tool is
 * unusable. If a prior-turn stdout matches any of these, we force the next
 * turn through `session/new` — otherwise `claude --resume` replays the
 * poisoned transcript and the model keeps refusing to try the tool even
 * after the wire has been fixed under it.
 *
 * Keep patterns specific enough to avoid resetting on benign mentions of
 * "MCP" or "tool" in chitchat. Each one is anchored on "opencara" or
 * "MCP <noun> isn't connected/available/running" together — both halves
 * have to land for a match.
 */
export const MCP_POISON_PATTERNS: readonly RegExp[] = [
  // "the `opencara_xyz` MCP tool isn't available" / "is not available"
  /\bopencara_\w+\b[^\n]{0,80}\b(isn['']?t|wasn['']?t|is not|was not)\s+available\b/i,
  // "opencara MCP server doesn't appear to be connected" / "MCP tools aren't
  // connected" — anchored on opencara + MCP + a negation contraction
  // (n't / don't / doesn't / isn't / aren't) within 80 chars of the
  // "connected|running|available|configured" verb.
  /\bopencara\s+MCP\b[^\n]{0,80}n['']?t\b[^\n]{0,50}\b(connected|running|available|configured)\b/i,
  // "opencara MCP server is not connected" (un-contracted form)
  /\bopencara\s+MCP\b[^\n]{0,80}\b(is not|are not|do(?:es)? not)\b[^\n]{0,50}\b(connected|running|available|configured)\b/i,
  // Generic "MCP server / tool isn't connected" (no "opencara" prefix —
  // catches phrasings where the assistant elides the qualifier)
  /\bMCP\s+(server|tools?)\b[^\n]{0,40}\b(isn['']?t|aren['']?t|is not|are not)\s+connected\b/i,
  // "MCP tools don't appear to be connected"
  /\bMCP\s+tools?\b[^\n]{0,40}\b(don['']?t|doesn['']?t|do not|does not)\s+appear\s+to\s+be\s+connected\b/i,
];

/**
 * Look at the most recent agent_run for this chat thread (matched by the
 * `OPENCARA_CHAT_SESSION_ID` env baked into spec) and return whether its
 * stdout contains a "this MCP tool isn't available" admission. Callers use
 * this to decide whether to discard `priorSessionId` on the upcoming turn.
 *
 * Returns false on any DB error or if no prior run is found — fall back to
 * normal resume rather than spuriously trashing context.
 */
async function priorTurnDeclaredMcpUnavailable(
  db: Db,
  sessionId: string,
): Promise<boolean> {
  try {
    const lastRun = await db.query.agentRuns.findFirst({
      where: sql`${agentRuns.spec}->'env'->>'OPENCARA_CHAT_SESSION_ID' = ${sessionId}`,
      orderBy: [desc(agentRuns.createdAt)],
    });
    if (!lastRun) return false;
    const logs = await db
      .select({ chunk: agentRunLogs.chunk })
      .from(agentRunLogs)
      .where(
        and(
          eq(agentRunLogs.agentRunId, lastRun.id),
          eq(agentRunLogs.stream, "stdout"),
        ),
      );
    if (logs.length === 0) return false;
    const stdout = logs.map((l) => l.chunk).join("");
    return MCP_POISON_PATTERNS.some((p) => p.test(stdout));
  } catch (err) {
    console.warn("[chat] priorTurnDeclaredMcpUnavailable check failed", {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
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
    // Per-turn knobs from the chat panel's toolbar. Plan mode is just
    // a shortcut for permissionMode='plan' — the panel renders both
    // controls but only the resolved mode crosses the wire. Unknown
    // values fall back to undefined (preserves agent default) rather
    // than 400'ing so a stale client doesn't break sending.
    const permissionMode = parsePermissionMode(body.permissionMode);

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
    let priorSessionId: string | undefined;
    if (
      chatRow?.acpSessionId &&
      chatRow.agentId === agentId &&
      chatRow.acpSessionId.length > 0
    ) {
      // Defensive de-poisoning: if the prior turn's stdout flagged an MCP
      // tool as unavailable, resuming that session would just re-feed the
      // model the same conclusion. Clear the persisted acpSessionId so
      // this turn goes through session/new — fresh tool list, fresh
      // transcript, no inherited "this tool doesn't work" memory.
      const poisoned = await priorTurnDeclaredMcpUnavailable(
        deps.db,
        sessionId,
      );
      if (poisoned) {
        console.warn(
          "[chat] previous turn marked an MCP tool unavailable; forcing session/new",
          {
            chatSessionId: chatRow.id,
            discardedAcpSessionId: chatRow.acpSessionId,
          },
        );
        await deps.db
          .update(chatSessions)
          .set({ acpSessionId: null, acpSessionHostId: null })
          .where(eq(chatSessions.id, chatRow.id));
      } else {
        priorSessionId = chatRow.acpSessionId;
      }
    }
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

    // Mint a per-turn installation token when the chat is project-scoped, so
    // the agent's `gh` commands (issue create/close/comment/labels — moved
    // off MCP) auth as the App against this project's repo. Scope is the
    // single repo + `issues: write` / `pull_requests: read`; lifetime is 1h
    // (way more than a single turn). On non-project pages, GH_TOKEN is
    // simply absent — `gh` will fail with a clean auth error rather than
    // silently doing the wrong thing.
    let ghToken: string | null = null;
    if (projectId && deps.app) {
      const projectRow = await deps.db
        .select({ project: projects, installation: githubInstallations })
        .from(projects)
        .where(and(eq(projects.id, projectId), isNull(projects.removedAt)))
        .innerJoin(
          githubInstallations,
          eq(projects.installationId, githubInstallations.id),
        )
        .limit(1);
      if (projectRow.length > 0) {
        const { project, installation } = projectRow[0]!;
        try {
          const ephemeral = await deps.app.mintEphemeralToken({
            installationId: installation.githubInstallationId,
            repositoryIds: [project.githubRepoId],
            permissions: {
              issues: "write",
              pull_requests: "read",
              metadata: "read",
              checks: "read",
            },
          });
          ghToken = ephemeral.token;
        } catch (err) {
          // Token mint failure is non-fatal — the chat still runs, just
          // without `gh` privileges. The agent will surface a 401 from gh
          // and the user can retry.
          console.warn("[chat] mintEphemeralToken failed", {
            projectId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

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
      ...(ghToken ? { GH_TOKEN: ghToken } : {}),
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
      ...(permissionMode ? { permissionMode } : {}),
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

    // Auto-title: if the chat row has no title yet, derive one from this
    // turn's user message so the History popover has something better
    // than "(untitled)" to render. Capped at 60 chars on the trimmed
    // body. Only fires when title is still NULL — once the user (or a
    // PATCH /chat/sessions/:id) sets it explicitly, we leave it alone.
    if (chatRow && chatRow.title === null) {
      const derived = message.trim().slice(0, 60);
      if (derived.length > 0) {
        try {
          await deps.db
            .update(chatSessions)
            .set({ title: derived })
            .where(eq(chatSessions.id, chatRow.id));
        } catch (err) {
          console.error("[chat] auto-title persist failed", err);
        }
      }
    }

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
          runId: agentRunId,
          onLog,
          hostId: dispatchHostId,
          projectId,
          userId: user.id,
          sessionId,
        });
        // First terminal write wins: when the user clicked Stop, the
        // cancel endpoint already flipped this row to "cancelled" with
        // cancel_reason="user_stopped". A late dispatcher resolve must
        // not clobber that with "failed" — we'd lose the cancel_reason
        // and the panel's SSE end event would carry the wrong status.
        // Guard symmetrically with the cancel endpoint's UPDATE.
        await deps.db
          .update(agentRuns)
          .set({
            status: result.exitCode === 0 ? "succeeded" : "failed",
            exitCode: result.exitCode,
            finishedAt: new Date(),
          })
          .where(
            and(
              eq(agentRuns.id, agentRunId),
              inArray(agentRuns.status, ["running", "queued", "assigned"]),
            ),
          );
        // Persist the session id the shim ran under, so the next turn
        // can resume via `priorSessionId`. Gated on (a) the run actually
        // succeeded — a failed run may have left the JSONL in a state
        // that --resume can't recover from cleanly, and (b) the chat
        // row still points at the SAME agent that ran this turn. If
        // the user switched agent mid-flight (chatSessions.ts cleared
        // acpSessionId on the POST), respect their choice instead of
        // silently re-pinning the row to the now-superseded agent.
        //
        // Inner try/catch isolates this best-effort side-effect from
        // the outer dispatcher catch. Without it, a transient DB error
        // here would fall through and flip the already-persisted
        // "succeeded" agentRuns row to "failed" — the user would see
        // the full streamed reply but the run log would lie about it.
        if (result.exitCode === 0 && result.acpSessionId) {
          try {
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
          } catch (persistErr) {
            // Log and move on. Worst case: next turn starts a fresh
            // session (no resume) — same behaviour as turn 1, not a
            // regression. The successful run stays successful.
            console.error("[chat] resume-persist failed", persistErr);
          }
        }
      } catch (err) {
        console.error("[chat] dispatcher run failed", err);
        // Same first-write-wins guard as the success branch.
        await deps.db
          .update(agentRuns)
          .set({ status: "failed", finishedAt: new Date() })
          .where(
            and(
              eq(agentRuns.id, agentRunId),
              inArray(agentRuns.status, ["running", "queued", "assigned"]),
            ),
          );
      }
      // Trigger one final SSE flush so the panel sees terminal state.
      void deps.pg.notify("agent_run_logs", agentRunId);
    })();

    return c.json({ agentRunId, sessionId, turnIndex });
  });

  /**
   * Stop the in-flight chat turn whose dispatched runId is `:runId`.
   *
   * Flow: flip the agent_runs row to "cancelled" (with cancel_reason for
   * traceability), then ask the dispatcher to forward a `cancel` frame to
   * the device. The device's AcpRunController calls ACP `session/cancel`
   * and force-closes the child after a short grace.
   *
   * The DB-side write is the load-bearing step — the SSE poll picks up
   * "cancelled" within 2s and the panel exits the streaming state. The
   * WS frame is best-effort; on a disconnected device the run still
   * appears cancelled in the UI, the orphan child gets cleaned by the
   * reaper on next orchestrator restart.
   *
   * Ownership gate is the same as runs.ts: addedByUserId match OR
   * project ownership.
   */
  r.post("/chat/messages/:runId/cancel", auth, async (c) => {
    const user = c.get("user")!;
    const runId = c.req.param("runId");

    const run = await deps.db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, runId),
      columns: {
        id: true,
        status: true,
        addedByUserId: true,
        projectId: true,
      },
    });
    if (!run) return c.json({ error: "not found" }, 404);
    // Ownership: direct attribution wins. Project gate is a follow-up
    // when chat runs grow non-creator readers — today the creator is
    // the only legitimate canceller.
    if (run.addedByUserId !== user.id) {
      return c.json({ error: "not found" }, 404);
    }
    if (run.status !== "running" && run.status !== "queued" && run.status !== "assigned") {
      return c.json({ error: "already terminal" }, 409);
    }

    // Guarded UPDATE: only flip if still non-terminal, so a `done`
    // arriving between the read above and this write doesn't get
    // clobbered into "cancelled" with the agent's real exit code lost.
    await deps.db
      .update(agentRuns)
      .set({
        status: "cancelled",
        cancelReason: "user_stopped",
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(agentRuns.id, runId),
          inArray(agentRuns.status, ["running", "queued", "assigned"]),
        ),
      );

    // Dispatcher resolves the device from its own in-memory pending
    // map — we used to read `agent_runs.host_id` here, but that column
    // is set only by the `done` handler (i.e. after the run finishes),
    // so reading it during a still-in-flight cancel always saw NULL
    // and silently no-op'd the WS signal. The agent kept running.
    const signalled = deps.dispatcher.cancel(runId, "user_stopped");

    // Wake up the SSE tail so the panel exits "streaming" without
    // waiting up to 2s for the next poll tick.
    void deps.pg.notify("agent_run_logs", runId);

    return c.json({ ok: true, signalled });
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

const PERMISSION_MODES = new Set<AcpPermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

function parsePermissionMode(raw: unknown): AcpPermissionMode | undefined {
  if (typeof raw !== "string") return undefined;
  return PERMISSION_MODES.has(raw as AcpPermissionMode)
    ? (raw as AcpPermissionMode)
    : undefined;
}
