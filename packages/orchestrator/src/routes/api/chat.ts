import { Hono } from "hono";
import { ulid } from "ulid";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Sql } from "postgres";
import type { HistoryTurn, ImageInput } from "@opencara/shared";
import type { Db } from "../../db/client.js";
import {
  agentRuns,
  agents,
  chatSessions,
  githubInstallations,
  projects,
} from "../../db/schema.js";
import type { AgentDispatcher } from "../../dispatch/dispatcher.js";
import { AgentLogSink } from "../../agents/logSink.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { loadOwnedProject } from "../../auth/ownership.js";
import { resolvePageSkill, type PageContextLike } from "../../flows/skills.js";
import { buildAgentSpec } from "../../agents/agentSpec.js";
import { mintEphemeralTokenWithRetry } from "../../github/app.js";
import type { EphemeralToken, GithubAppClient } from "../../github/app.js";

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
 * Chat with a user-defined agent. Each turn dispatches one agent turn to a
 * device, resuming the thread's durable conversation when the chat row holds
 * one; env carries OPENCARA_CHAT_* for the agent's shell commands.
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
    // Image attachments for this turn (clipboard paste / drag-and-drop).
    // Validated + capped here so a hostile or buggy client can't push an
    // unbounded base64 blob into the agent prompt. Malformed entries are
    // dropped rather than 400'ing the whole turn.
    const images = normalizeImages(body.images);

    // A turn needs *some* content — text or at least one image. An
    // image-only turn (e.g. "what's wrong with this screenshot?" with no
    // typed text) is valid, so we no longer hard-require message text.
    if (
      !agentId ||
      !sessionId ||
      (!message.trim() && images.length === 0) ||
      !Number.isFinite(turnIndex)
    ) {
      return c.json(
        {
          error:
            "agentId, sessionId, turnIndex, and message (or at least one image) are required",
        },
        400,
      );
    }

    const agent = await deps.db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.userId, user.id)),
    });
    if (!agent) return c.json({ error: "agent not found" }, 404);

    // Resume continuity: a prior turn on this thread (same user, same
    // threadKey) wrote `conversationId` + `conversationHostId` after a
    // successful dispatch. If the user hasn't switched agent since, we
    // pass that id as `priorConversationId` so the device resumes the
    // durable conversation instead of replaying `history`.
    //
    // Mismatched agentId means the user picked a different agent
    // (chatSessions.ts POST clears conversationId when that happens, but
    // races between the agent-pick PATCH and an in-flight message are
    // possible). Drop the id rather than resume another agent's
    // conversation.
    const chatRow = await deps.db.query.chatSessions.findFirst({
      where: and(
        eq(chatSessions.userId, user.id),
        eq(chatSessions.threadKey, sessionId),
      ),
    });
    const priorConversationId =
      chatRow?.conversationId && chatRow.agentId === agentId
        ? chatRow.conversationId
        : undefined;
    // Pin to the device that holds the conversation. Falls back to the
    // agent's own hostId (and then to any idle host) when this is turn 1
    // or the prior host record was cleared.
    const dispatchHostId =
      (priorConversationId ? chatRow?.conversationHostId : null) ?? agent.hostId;

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
    // the agent's `gh` commands (issue create/close/comment/labels — no
    // opencara tool) auth as the App against this project's repo. Scope is the
    // single repo + `issues: write` / `pull_requests: read`; lifetime is 1h
    // (way more than a single turn). On non-project pages, GH_TOKEN is
    // simply absent — `gh` will fail with a clean auth error rather than
    // silently doing the wrong thing.
    let mintedToken: EphemeralToken | null = null;
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
      // The inner join on githubInstallations already restricts this to GitHub
      // projects; the extra githubRepoId check just narrows the nullable column
      // (Azure DevOps projects leave it NULL).
      if (projectRow.length > 0 && projectRow[0]!.project.githubRepoId !== null) {
        const { project, installation } = projectRow[0]!;
        try {
          mintedToken = await mintEphemeralTokenWithRetry(deps.app, {
            installationId: installation.githubInstallationId,
            repositoryIds: [project.githubRepoId!],
            permissions: {
              issues: "write",
              pull_requests: "read",
              metadata: "read",
              checks: "read",
            },
          });
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
    // persisted spec includes everything the agent will actually see —
    // EXCEPT the GH token, which is persisted as an `<ephemeral>` marker
    // (mirroring dispatchAgentRun in flows/nodeRunners.ts). The live token
    // is written onto the in-memory spec.env AFTER the insert, so it
    // reaches the device but never the DB row.
    const tokenPlaceholder = "<ephemeral>";
    const env: Record<string, string> = {
      ...agent.env,
      OPENCARA_CHAT_SESSION_ID: sessionId,
      OPENCARA_CHAT_TURN_INDEX: String(turnIndex),
      OPENCARA_CHAT_PAGE_CONTEXT: JSON.stringify(pageContext),
      OPENCARA_AGENT_RUN_ID: agentRunId,
      ...(mintedToken ? { GH_TOKEN: tokenPlaceholder } : {}),
    };

    // Merge the skill builder's hydrated server-side data (e.g. the full
    // issue.bodyMd for the issue canvas) into the pageContext the agent
    // sees. Without this the agent only gets what the frontend sent —
    // notably `canvas.selection` without the surrounding body — and a
    // selection-scoped edit request degenerates into "rewrite the whole
    // body with just the selection", wiping the issue.
    const agentPageContext: Record<string, unknown> = {
      ...(pageContext as Record<string, unknown>),
      ...(skillResult?.hydrated ?? {}),
    };

    const spec = buildAgentSpec({
      agent,
      env,
      systemPromptMd: withChatResponseInstructions(
        skillResult?.skill.instructions ??
          "You are an opencara chat agent. Respond to the user's message about the current page.",
      ),
      userPromptMd: message,
      history: normalizeHistory(history),
      pageContext: agentPageContext,
      priorConversationId,
      images,
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

    // Inject the real token only after the spec snapshot is persisted.
    // spec.env is the object the dispatcher serializes to the device, so
    // this mutation affects the wire copy but not the DB row above.
    if (mintedToken) {
      spec.env["GH_TOKEN"] = mintedToken.token;
    }

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

    const logSink = new AgentLogSink(deps.db, deps.pg, agentRunId);

    // Fire-and-forget the dispatcher; the SSE stream is the client's only view.
    void (async () => {
      try {
        const result = await deps.dispatcher.run(spec, {
          runId: agentRunId,
          onLog: logSink.push,
          hostId: dispatchHostId,
          projectId,
          userId: user.id,
          sessionId,
        });
        // Drain buffered log chunks before the terminal write — the SSE
        // end event goes out on the status flip, so the last chunks must
        // already be durable or the tail would arrive after "end".
        await logSink.close();
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
        // Persist the conversation this turn ran in, so the next turn
        // can resume it via `priorConversationId`. Gated on (a) the run
        // actually succeeded, and (b) the chat row still points at the
        // SAME agent that ran this turn. If the user switched agent
        // mid-flight (chatSessions.ts cleared conversationId on the
        // POST), respect their choice instead of silently re-pinning the
        // row to the now-superseded agent.
        //
        // Inner try/catch isolates this best-effort side-effect from
        // the outer dispatcher catch. Without it, a transient DB error
        // here would fall through and flip the already-persisted
        // "succeeded" agentRuns row to "failed" — the user would see
        // the full streamed reply but the run log would lie about it.
        if (result.exitCode === 0 && result.conversationId) {
          try {
            await deps.db
              .update(chatSessions)
              .set({
                conversationId: result.conversationId,
                conversationHostId: result.agentHostId,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatSessions.userId, user.id),
                  eq(chatSessions.threadKey, sessionId),
                  // Match when the row's agentId equals the request's
                  // agentId OR is still NULL (auto-pick POST hasn't
                  // landed yet). Rejects a *different* agent (mid-flight
                  // switch) so we don't re-pin a superseded agent's
                  // conversation onto the new pick.
                  sql`(${chatSessions.agentId} IS NULL OR ${chatSessions.agentId} = ${agentId})`,
                ),
              );
          } catch (persistErr) {
            // Log and move on. Worst case: next turn starts a fresh
            // conversation (no resume) — same behaviour as turn 1, not a
            // regression. The successful run stays successful.
            console.error("[chat] resume-persist failed", persistErr);
          }
        }
      } catch (err) {
        console.error("[chat] dispatcher run failed", err);
        await logSink.close();
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
      } finally {
        if (mintedToken && deps.app) {
          // Best-effort revoke, mirroring dispatchAgentRun: the token
          // expires in ≤1h regardless, so a network blip here is logged
          // and swallowed rather than failing the already-finished turn.
          await deps.app.revokeToken(mintedToken.token).catch((err: unknown) => {
            console.error("[chat] revokeToken failed", err);
          });
        }
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
   * the device, which aborts the in-flight agent turn.
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
 * Per-turn image attachment limits. Generous enough for a handful of
 * screenshots, tight enough that a runaway client can't blow up the
 * agent prompt or the persisted spec. Base64 inflates bytes ~4/3, so
 * ~10M base64 chars ≈ 7.5 MB of raw image — comfortably above a typical
 * full-screen PNG.
 */
const MAX_IMAGES_PER_TURN = 8;
const MAX_IMAGE_BASE64_LEN = 10_000_000;
// Aggregate cap across all attachments on one turn. The whole payload is
// persisted into the run's spec (jsonb), so bound the worst case
// (8 × per-image cap ≈ 80 MB) to something a single row + a single agent
// prompt can carry. ~24 MB base64 ≈ 18 MB of raw image total per turn.
const MAX_IMAGES_TOTAL_BASE64_LEN = 24_000_000;
const ALLOWED_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

/**
 * Coerce the chat panel's image payload into validated `ImageInput[]`.
 * Each entry must be `{ data: <base64, no data: prefix>, mimeType: image/* }`.
 * Oversized / wrong-type / malformed entries are dropped (not fatal); the
 * list is capped at `MAX_IMAGES_PER_TURN` and the combined base64 length
 * at `MAX_IMAGES_TOTAL_BASE64_LEN`.
 */
export function normalizeImages(raw: unknown): ImageInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageInput[] = [];
  let totalLen = 0;
  for (const item of raw) {
    if (out.length >= MAX_IMAGES_PER_TURN) break;
    if (!item || typeof item !== "object") continue;
    const { data, mimeType } = item as { data?: unknown; mimeType?: unknown };
    if (typeof data !== "string" || data.length === 0) continue;
    if (data.length > MAX_IMAGE_BASE64_LEN) continue;
    if (totalLen + data.length > MAX_IMAGES_TOTAL_BASE64_LEN) break;
    if (typeof mimeType !== "string" || !ALLOWED_IMAGE_MIME.test(mimeType)) {
      continue;
    }
    out.push({ data, mimeType: mimeType.toLowerCase() });
    totalLen += data.length;
  }
  return out;
}

/**
 * Coerce the chat panel's free-form history payload into the strict
 * `HistoryTurn[]` shape. The panel sends `{role, text}` tuples but
 * may include other fields we don't care about; we just keep the two
 * we need and drop anything that doesn't have a recognized role.
 */
function normalizeHistory(history: unknown[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const raw of history) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { role?: unknown; text?: unknown };
    if (r.role !== "user" && r.role !== "assistant") continue;
    if (typeof r.text !== "string") continue;
    out.push({ role: r.role, text: r.text });
  }
  return out;
}

function withChatResponseInstructions(systemPromptMd: string): string {
  return `${systemPromptMd.trim()}

## Chat response options

When the user should choose from predefined replies, include an options payload in your assistant response. Put any explanatory prose before it, or set \`text\` in the payload if the options are the whole response.

\`\`\`json
{
  "type": "options",
  "text": "Choose an option:",
  "options": [
    { "label": "Yes", "value": "Yes" },
    { "label": "No", "value": "No" }
  ]
}
\`\`\`

The chat panel renders each option as a button. Clicking a button sends that option's \`value\` as the user's next message.`;
}
