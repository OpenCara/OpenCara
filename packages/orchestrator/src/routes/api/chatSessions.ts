// Per-(user, scope) chat session lookups. Every page in the web app that
// opens the ChatPanel resolves a `(scopeKind, scopeId)` from its URL and
// auto-loads/creates the active session row here; the row's `threadKey`
// becomes the agent `--resume`/`--continue` session id, so re-opening the
// panel on the same scope picks up the same conversation.
//
//   scope_kind='project'  → scope_id=projectId   (gated by loadOwnedProject)
//   scope_kind='template' → scope_id=templateSlug (user-scoped already)
//   scope_kind='user'     → scope_id=''           (per-user, page-agnostic)
//
// Multi-session model (post-#0026): a (user, scope) tuple can hold any
// number of rows. The "active" row is the most-recent non-archived one;
// "New chat" archives the current active row (sets archived_at) and
// inserts a fresh row, which then becomes active. The History popover
// in the chat panel lists all rows for the scope so the user can switch
// back to an archived thread.
//
// Routes:
//   GET    /api/chat/sessions?scopeKind=…&scopeId=…       (active row)
//   POST   /api/chat/sessions       body { scopeKind, scopeId, agentId }
//   GET    /api/chat/sessions/list?scopeKind=…&scopeId=…  (all rows)
//   POST   /api/chat/sessions/new   body { scopeKind, scopeId, agentId? }
//   PATCH  /api/chat/sessions/:id   body { title?, archivedAt? }
//   DELETE /api/chat/sessions/:id?hard=1

import { Hono } from "hono";
import { ulid } from "ulid";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  CHAT_SESSION_SCOPE_KINDS,
  type ChatSessionScopeKind,
  agentRunLogs,
  agentRuns,
  chatSessions,
  flowRunSteps,
  flowRuns,
  flowNodeSettings,
} from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { loadOwnedProject } from "../../auth/ownership.js";

interface ChatSessionsRoutesDeps {
  db: Db;
}

interface SessionResponse {
  id: string;
  scopeKind: ChatSessionScopeKind;
  scopeId: string;
  threadKey: string;
  agentId: string | null;
  title: string | null;
  archivedAt: string | null;
  updatedAt: string;
  /**
   * True when this session has an in-flight agent run (queued / assigned /
   * running). Only populated by the list endpoint — the single-session
   * resolver leaves it unset. Drives the "Running" group in the chat
   * panel's session sidebar (see issue #143).
   */
  running?: boolean;
}

function parseScopeKind(raw: string | undefined): ChatSessionScopeKind | null {
  return (CHAT_SESSION_SCOPE_KINDS as readonly string[]).includes(raw ?? "")
    ? (raw as ChatSessionScopeKind)
    : null;
}

// Normalize project scopes that arrive without a scopeId (shouldn't happen,
// but the type allows it). For 'user' we accept any empty/missing id.
function normalizedScopeId(kind: ChatSessionScopeKind, scopeId: string): string {
  if (kind === "user") return "";
  return scopeId;
}

async function gateScope(
  deps: ChatSessionsRoutesDeps,
  userId: string,
  kind: ChatSessionScopeKind,
  scopeId: string,
): Promise<{ ok: true } | { ok: false; status: 400 | 404; error: string }> {
  if (kind === "project") {
    if (!scopeId) return { ok: false, status: 400, error: "scopeId required for project scope" };
    const owned = await loadOwnedProject(deps.db, scopeId, userId);
    if (!owned) return { ok: false, status: 404, error: "not found" };
    return { ok: true };
  }
  if (kind === "template") {
    // template_drafts is already keyed by (userId, templateSlug); a user
    // can only ever resolve to their own template, so no extra check.
    if (!scopeId) return { ok: false, status: 400, error: "scopeId required for template scope" };
    return { ok: true };
  }
  if (kind === "flow_run_step") {
    if (!scopeId) {
      return { ok: false, status: 400, error: "scopeId required for flow_run_step scope" };
    }
    const owned = await loadFlowRunStepProject(deps.db, scopeId, userId);
    if (!owned) return { ok: false, status: 404, error: "not found" };
    return { ok: true };
  }
  // 'user' scope: no extra check beyond auth.
  return { ok: true };
}

// Resolves a flow_run_step to its owning project, gated by user ownership.
// Returns the projectId on success, undefined otherwise. The step → project
// chain is step → flow_run → project; we join all three rather than reading
// flow_run.projectId on faith, so a request that smuggles a step id from
// another user's project bounces.
//
// Exported for unit tests that exercise the gate with a fake Db.
export async function loadFlowRunStepProject(
  db: Db,
  stepId: string,
  userId: string,
): Promise<string | undefined> {
  const step = await db.query.flowRunSteps.findFirst({
    where: eq(flowRunSteps.id, stepId),
    columns: { flowRunId: true },
  });
  if (!step) return undefined;
  const run = await db.query.flowRuns.findFirst({
    where: eq(flowRuns.id, step.flowRunId),
    columns: { projectId: true },
  });
  if (!run) return undefined;
  const owned = await loadOwnedProject(db, run.projectId, userId);
  return owned ? run.projectId : undefined;
}

// For the flow_run_step scope, look up the underlying agent_run linked
// to this step and return the values we want to pre-seed the chat row
// with. Reading the row at session-create time means the first chat
// turn resumes the ACP session straight away — no extra "associate
// session" round-trip from the panel.
//
// Exported for unit tests that exercise hydration with a fake Db.
export async function hydrateFromFlowRunStep(
  db: Db,
  stepId: string,
): Promise<{
  agentId: string | null;
  acpSessionId: string | null;
  acpSessionHostId: string | null;
}> {
  const step = await db.query.flowRunSteps.findFirst({
    where: eq(flowRunSteps.id, stepId),
    columns: { id: true, flowRunId: true, nodeId: true },
  });
  if (!step) {
    return { agentId: null, acpSessionId: null, acpSessionHostId: null };
  }
  const run = await db.query.flowRuns.findFirst({
    where: eq(flowRuns.id, step.flowRunId),
    columns: { flowId: true },
  });
  // Most recent agent_run for the step wins. A failed first iteration
  // followed by a successful retry is the common shape; chatting from
  // the page targets the latest run's session for resume continuity.
  const lastRun = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.flowRunStepId, step.id),
    orderBy: [desc(agentRuns.createdAt)],
    columns: { id: true, hostId: true, spec: true },
  });
  const setting = run
    ? await db.query.flowNodeSettings.findFirst({
        where: and(
          eq(flowNodeSettings.flowId, run.flowId),
          eq(flowNodeSettings.nodeId, step.nodeId),
        ),
        columns: { agentId: true },
      })
    : undefined;
  const spec = (lastRun?.spec ?? null) as
    | { acp?: { priorSessionId?: string | null } | null }
    | null;
  // The orchestrator persists the resulting acpSessionId back onto the
  // spec only via the chat path; flow-engine runs don't write it back
  // onto the agent_runs row today. Fall back to priorSessionId so a
  // resumed iteration's chat still picks up the right id.
  const acpSessionId = spec?.acp?.priorSessionId ?? null;
  return {
    agentId: setting?.agentId ?? null,
    acpSessionId,
    acpSessionHostId: lastRun?.hostId ?? null,
  };
}

function toResponse(row: typeof chatSessions.$inferSelect): SessionResponse {
  return {
    id: row.id,
    scopeKind: row.scopeKind as ChatSessionScopeKind,
    scopeId: row.scopeId,
    threadKey: row.threadKey,
    agentId: row.agentId,
    title: row.title,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// "Active session" for a scope = most-recent-non-archived row. With the
// 0026 migration, a (user, scope) may hold many rows; the History popover
// lists them all, but every page-mount and every POST /chat/messages still
// boils down to picking exactly one row to drive — this query is that pick.
async function findActiveSession(
  deps: ChatSessionsRoutesDeps,
  userId: string,
  scopeKind: ChatSessionScopeKind,
  scopeId: string,
): Promise<typeof chatSessions.$inferSelect | undefined> {
  return deps.db.query.chatSessions.findFirst({
    where: and(
      eq(chatSessions.userId, userId),
      eq(chatSessions.scopeKind, scopeKind),
      eq(chatSessions.scopeId, scopeId),
      isNull(chatSessions.archivedAt),
    ),
    orderBy: [desc(chatSessions.updatedAt)],
  });
}

// Resolve which chat_sessions row a `POST /chat/sessions` agent-pick write
// should target. With `sessionId`, the named row — bounded to (user, scope)
// so a smuggled id from another scope/user doesn't resolve — is
// authoritative, and `notFound` is true when it doesn't resolve (the route
// then 404s instead of silently rewriting some other row). Without it, the
// scope's most-recent active row is used (undefined → the route creates a
// fresh one). Extracted so the #143 multi-active-session targeting — the
// case that motivated this path — is unit-tested.
//
// Exported for unit tests that exercise it against a fake Db.
export async function resolveAgentWriteTarget(
  db: Db,
  userId: string,
  kind: ChatSessionScopeKind,
  scopeId: string,
  sessionId: string | null,
): Promise<{
  row: typeof chatSessions.$inferSelect | undefined;
  notFound: boolean;
}> {
  if (sessionId) {
    const row = await db.query.chatSessions.findFirst({
      where: and(
        eq(chatSessions.id, sessionId),
        eq(chatSessions.userId, userId),
        eq(chatSessions.scopeKind, kind),
        eq(chatSessions.scopeId, scopeId),
      ),
    });
    return { row: row ?? undefined, notFound: !row };
  }
  const row = await findActiveSession({ db }, userId, kind, scopeId);
  return { row, notFound: false };
}

// Given a set of session threadKeys, return the subset that currently has
// an in-flight agent run. A chat turn is dispatched as an `agent_runs` row
// carrying `spec.env.OPENCARA_CHAT_SESSION_ID = threadKey` (same marker the
// /history endpoint joins on); a session is "running" when any such run is
// still queued / assigned / running. Used by the list endpoint to populate
// the per-session `running` flag (issue #143).
//
// Exported for unit tests that exercise it against a fake Db.
export async function selectActiveChatThreadKeys(
  db: Db,
  threadKeys: string[],
): Promise<Set<string>> {
  if (threadKeys.length === 0) return new Set();
  const requested = new Set(threadKeys);
  const sessionIdExpr = sql<string>`(${agentRuns.spec}->'env'->>'OPENCARA_CHAT_SESSION_ID')`;
  const active = await db.query.agentRuns.findMany({
    where: and(
      inArray(agentRuns.status, ["queued", "assigned", "running"]),
      inArray(sessionIdExpr, threadKeys),
    ),
    columns: { spec: true },
  });
  const running = new Set<string>();
  for (const run of active) {
    const spec = run.spec as { env?: Record<string, string> } | null;
    const key = spec?.env?.OPENCARA_CHAT_SESSION_ID;
    // Intersect with the requested set rather than trusting the row blindly
    // — keeps the result scoped to the caller's threadKeys even if the
    // query ever returns a stray marker.
    if (key && requested.has(key)) running.add(key);
  }
  return running;
}

export function chatSessionsRoutes(deps: ChatSessionsRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  // GET /chat/sessions — resolve (and lazy-create) the session for the
  // current user + scope. Returns { session }.
  r.get("/chat/sessions", auth, async (c) => {
    const user = c.get("user")!;
    const kind = parseScopeKind(c.req.query("scopeKind"));
    if (!kind) return c.json({ error: "invalid scopeKind" }, 400);
    const scopeId = normalizedScopeId(kind, c.req.query("scopeId") ?? "");

    const gate = await gateScope(deps, user.id, kind, scopeId);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);

    // Read-then-insert: with the 0026 migration moving the PK to the
    // per-row ULID `id`, the old onConflictDoNothing() target no longer
    // matches the "one row per scope" intent — two concurrent first-time
    // visitors would each succeed and create two unarchived rows. Instead,
    // check for an existing active row; only insert when there is none.
    // The window between the read and the insert is small (~1 RTT) and the
    // worst case is a duplicate row that the active-session query still
    // resolves to one of them.
    const existing = await findActiveSession(deps, user.id, kind, scopeId);
    if (existing) {
      // Re-hydrate stale rows on flow_run_step scope. If the panel
      // was opened before the flow agent finished writing back its
      // acpSessionId, the row's column will still be NULL — a later
      // re-open (typical UI flow) needs to re-attempt the seed,
      // otherwise the row is permanently stranded on a null session
      // even after the flow agent wrote the id back. Best-effort:
      // any DB error here is swallowed and the existing row is
      // returned unchanged. agentId/acpSessionHostId fill in the
      // same way so multi-iteration runs catch up.
      if (
        kind === "flow_run_step" &&
        (!existing.acpSessionId || !existing.agentId)
      ) {
        const seed = await hydrateFromFlowRunStep(deps.db, scopeId);
        const updates: Partial<typeof chatSessions.$inferInsert> = {};
        if (!existing.acpSessionId && seed.acpSessionId) {
          updates.acpSessionId = seed.acpSessionId;
        }
        if (!existing.acpSessionHostId && seed.acpSessionHostId) {
          updates.acpSessionHostId = seed.acpSessionHostId;
        }
        if (!existing.agentId && seed.agentId) updates.agentId = seed.agentId;
        if (Object.keys(updates).length > 0) {
          try {
            const [rehydrated] = await deps.db
              .update(chatSessions)
              .set(updates)
              .where(eq(chatSessions.id, existing.id))
              .returning();
            return c.json({ session: toResponse(rehydrated!) });
          } catch (err) {
            console.error("[chat] re-hydrate failed", err);
          }
        }
      }
      return c.json({ session: toResponse(existing) });
    }

    const id = `chat_${ulid()}`;
    const threadKey = id;
    const now = new Date();
    // For flow_run_step scope, pre-seed the row with the agent + ACP
    // session id of the underlying flow agent run, so the very first
    // user message resumes that conversation instead of starting fresh.
    const seed =
      kind === "flow_run_step"
        ? await hydrateFromFlowRunStep(deps.db, scopeId)
        : { agentId: null, acpSessionId: null, acpSessionHostId: null };
    const [created] = await deps.db
      .insert(chatSessions)
      .values({
        id,
        userId: user.id,
        scopeKind: kind,
        scopeId,
        threadKey,
        agentId: seed.agentId,
        acpSessionId: seed.acpSessionId,
        acpSessionHostId: seed.acpSessionHostId,
        updatedAt: now,
      })
      .returning();
    return c.json({ session: toResponse(created!) });
  });

  // POST /chat/sessions — upsert the agent pick for a session.
  // Body: { scopeKind, scopeId, agentId, sessionId? }. agentId may be null.
  //
  // `sessionId` targets a SPECIFIC row (the one the panel is currently
  // viewing). It matters since #143: the session sidebar can leave several
  // non-archived rows in a scope, so resolving the target by scope alone
  // (`findActiveSession` = most-recent active) would write the agent pick
  // onto whichever row was touched last — not the one the user is looking
  // at, clobbering an unrelated conversation's agent + ACP session. When
  // `sessionId` is omitted we keep the legacy scope-resolve-or-create
  // behaviour (first-ever pick on a fresh scope).
  r.post("/chat/sessions", auth, async (c) => {
    const user = c.get("user")!;
    const body = (await c.req.json().catch(() => ({}))) as {
      scopeKind?: string;
      scopeId?: string;
      agentId?: string | null;
      sessionId?: string;
    };
    const kind = parseScopeKind(body.scopeKind);
    if (!kind) return c.json({ error: "invalid scopeKind" }, 400);
    const scopeId = normalizedScopeId(kind, body.scopeId ?? "");
    const agentId = body.agentId ?? null;
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : null;

    const gate = await gateScope(deps, user.id, kind, scopeId);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);

    // When the caller names a session, that row is authoritative — bounded
    // to (user, scope) so a smuggled id from another scope/user 404s rather
    // than being silently rewritten. Otherwise fall back to the active row.
    const target = await resolveAgentWriteTarget(
      deps.db,
      user.id,
      kind,
      scopeId,
      sessionId,
    );
    if (target.notFound) return c.json({ error: "not found" }, 404);
    const existing = target.row;

    const now = new Date();
    if (!existing) {
      const id = `chat_${ulid()}`;
      const threadKey = id;
      // Same hydration as the GET path — a panel that POSTs without
      // first GETting still ends up on a row with the flow agent's
      // acpSessionId pre-populated, so the very first user message
      // resumes the conversation. Inherit the seeded acpSessionId
      // whenever the caller didn't disagree on the agent — when the
      // caller's agentId is null OR matches the seed, we keep the
      // resume. A different explicit pick from the caller wipes it,
      // matching the "agent switch invalidates the session" rule
      // below.
      const seed =
        kind === "flow_run_step"
          ? await hydrateFromFlowRunStep(deps.db, scopeId)
          : { agentId: null, acpSessionId: null, acpSessionHostId: null };
      const resolvedAgentId = agentId ?? seed.agentId;
      const inheritsAcp =
        kind === "flow_run_step" &&
        (agentId === null || seed.agentId === null || seed.agentId === agentId);
      const [created] = await deps.db
        .insert(chatSessions)
        .values({
          id,
          userId: user.id,
          scopeKind: kind,
          scopeId,
          threadKey,
          agentId: resolvedAgentId,
          acpSessionId: inheritsAcp ? seed.acpSessionId : null,
          acpSessionHostId: inheritsAcp ? seed.acpSessionHostId : null,
          updatedAt: now,
        })
        .returning();
      return c.json({ session: toResponse(created!) });
    }

    // Agent SWITCH (specific → different specific) invalidates the
    // cached ACP session: the new shim hasn't created the prior
    // session's JSONL on any device, so a `--resume <prior-uuid>`
    // would just error. Clear both columns alongside the agentId
    // write so the next turn starts fresh.
    //
    // A null → specific transition is NOT a switch — it's the first
    // time the user has picked an agent on this row. Wiping the
    // seeded `acpSessionId` here would silently neutralize the
    // flow_run_step scope's whole point (resume the agent's session).
    // Same for replaying the same value.
    const agentChanged =
      existing.agentId !== null && agentId !== null && existing.agentId !== agentId;
    const [updated] = await deps.db
      .update(chatSessions)
      .set({
        agentId,
        updatedAt: now,
        ...(agentChanged
          ? { acpSessionId: null, acpSessionHostId: null }
          : {}),
      })
      .where(eq(chatSessions.id, existing.id))
      .returning();
    return c.json({ session: toResponse(updated!) });
  });

  // GET /chat/sessions/list — list every chat session for the (user, scope),
  // most recent first. Drives the History popover in the chat panel. Both
  // active and archived rows are returned; the panel renders archived ones
  // with a badge.
  r.get("/chat/sessions/list", auth, async (c) => {
    const user = c.get("user")!;
    const kind = parseScopeKind(c.req.query("scopeKind"));
    if (!kind) return c.json({ error: "invalid scopeKind" }, 400);
    const scopeId = normalizedScopeId(kind, c.req.query("scopeId") ?? "");

    const gate = await gateScope(deps, user.id, kind, scopeId);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);

    const rows = await deps.db.query.chatSessions.findMany({
      where: and(
        eq(chatSessions.userId, user.id),
        eq(chatSessions.scopeKind, kind),
        eq(chatSessions.scopeId, scopeId),
      ),
      orderBy: [desc(chatSessions.updatedAt)],
      limit: 50,
    });
    const runningKeys = await selectActiveChatThreadKeys(
      deps.db,
      rows.map((r) => r.threadKey),
    );
    return c.json({
      sessions: rows.map((r) => ({
        ...toResponse(r),
        running: runningKeys.has(r.threadKey),
      })),
    });
  });

  // POST /chat/sessions/new — "New chat" button. Archives the current
  // active row (if any) and inserts a fresh one; returns the new row.
  // The fresh row's id IS its threadKey so chat.ts's existing resume
  // lookup (by threadKey) keeps working unchanged.
  //
  // Optional `agentId` lets the panel persist the user's current agent
  // pick onto the new row in the same trip — saves a follow-up POST
  // /chat/sessions just to set it.
  //
  // `archivePrevious` (default true) controls whether the currently-active
  // row is archived. The session-sidebar "+" button (issue #143) passes
  // false: it wants the prior conversation to stay visible under the
  // sidebar's "History" group rather than be tucked away under "Archived".
  r.post("/chat/sessions/new", auth, async (c) => {
    const user = c.get("user")!;
    const body = (await c.req.json().catch(() => ({}))) as {
      scopeKind?: string;
      scopeId?: string;
      agentId?: string | null;
      archivePrevious?: boolean;
    };
    const kind = parseScopeKind(body.scopeKind);
    if (!kind) return c.json({ error: "invalid scopeKind" }, 400);
    const scopeId = normalizedScopeId(kind, body.scopeId ?? "");
    const agentId = body.agentId ?? null;
    const archivePrevious = body.archivePrevious ?? true;

    const gate = await gateScope(deps, user.id, kind, scopeId);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);

    const now = new Date();
    // Archive the currently-active row, if any. Done in a separate
    // statement (not a transaction) — a race where two browsers click
    // "New chat" simultaneously leaves both prior actives archived
    // and two fresh rows in their place; the next GET picks the
    // most-recently-updated one. Slightly wasteful but correct.
    const existing = archivePrevious
      ? await findActiveSession(deps, user.id, kind, scopeId)
      : undefined;
    if (existing) {
      await deps.db
        .update(chatSessions)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(chatSessions.id, existing.id));
    }

    // /new path also pre-seeds for flow_run_step. The previous active
    // row was just archived above; the fresh row should re-pick up the
    // step's ACP session id so the new conversation also resumes the
    // flow agent (otherwise "New chat" inside this scope would silently
    // strand the user on a fresh session/new).
    const seed =
      kind === "flow_run_step"
        ? await hydrateFromFlowRunStep(deps.db, scopeId)
        : { agentId: null, acpSessionId: null, acpSessionHostId: null };
    const resolvedAgentId = agentId ?? seed.agentId;
    // Same inheritance rule as the POST /chat/sessions path: keep the
    // seeded acpSessionId unless the caller explicitly chose a
    // DIFFERENT agent than the one the flow ran with. A null caller
    // pick, or a missing seed.agentId, still inherits.
    const inheritsAcp =
      kind === "flow_run_step" &&
      (agentId === null || seed.agentId === null || seed.agentId === agentId);
    const id = `chat_${ulid()}`;
    const threadKey = id;
    const [created] = await deps.db
      .insert(chatSessions)
      .values({
        id,
        userId: user.id,
        scopeKind: kind,
        scopeId,
        threadKey,
        agentId: resolvedAgentId,
        acpSessionId: inheritsAcp ? seed.acpSessionId : null,
        acpSessionHostId: inheritsAcp ? seed.acpSessionHostId : null,
        updatedAt: now,
      })
      .returning();
    return c.json({ session: toResponse(created!) });
  });

  // GET /chat/sessions/:id/history — return prior turns on this session.
  //
  // Used by the steering chat panel (and any other page-mounted chat
  // surface) to repopulate the message list after remount / refresh /
  // run completion. Each turn corresponds to one `agent_runs` row
  // whose env carries `OPENCARA_CHAT_SESSION_ID = threadKey`. We
  // surface:
  //   - turn.user — the userPromptMd from the persisted spec
  //   - turn.assistant — concatenated stdout from agent_run_logs
  //   - turn.status — the run's terminal status (or "running")
  //
  // No SSE here; that's still /api/runs/:agentRunId/logs/stream for
  // turns that are still in flight. The panel pairs them up: history
  // hydrates the past, SSE drives the present.
  r.get("/chat/sessions/:id/history", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const row = await deps.db.query.chatSessions.findFirst({
      where: and(eq(chatSessions.id, id), eq(chatSessions.userId, user.id)),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 1),
      200,
    );
    // Per-turn agent_runs are matched by the chat-route env marker so
    // we don't need a denormalized join table. Ordering is ascending
    // so the panel can render turns in conversation order without
    // re-sorting client-side.
    const runs = await deps.db.query.agentRuns.findMany({
      where: sql`${agentRuns.spec}->'env'->>'OPENCARA_CHAT_SESSION_ID' = ${row.threadKey}`,
      orderBy: [asc(agentRuns.createdAt)],
      limit,
    });
    const turns = await Promise.all(
      runs.map(async (r) => {
        const spec = r.spec as
          | { acp?: { userPromptMd?: string } | null }
          | null;
        const userText = spec?.acp?.userPromptMd ?? "";
        const logs = await deps.db
          .select({ chunk: agentRunLogs.chunk })
          .from(agentRunLogs)
          .where(
            and(
              eq(agentRunLogs.agentRunId, r.id),
              eq(agentRunLogs.stream, "stdout"),
            ),
          )
          .orderBy(asc(agentRunLogs.seq));
        const assistantText = logs.map((l) => l.chunk).join("");
        return {
          agentRunId: r.id,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          user: userText,
          assistant: assistantText,
        };
      }),
    );
    return c.json({ turns });
  });

  // PATCH /chat/sessions/:id — rename a session or toggle its archive
  // state. Used by the History popover for the inline rename UX and
  // for the "restore" action on archived rows.
  //
  // Body fields:
  //   title:       new title (string or null to clear)
  //   archivedAt:  ISO timestamp string, or null to un-archive
  r.patch("/chat/sessions/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string | null;
      archivedAt?: string | null;
    };
    const row = await deps.db.query.chatSessions.findFirst({
      where: and(eq(chatSessions.id, id), eq(chatSessions.userId, user.id)),
    });
    if (!row) return c.json({ error: "not found" }, 404);

    const updates: Partial<typeof chatSessions.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.title !== undefined) {
      // Cap at 200 — the chat panel renders titles in a one-line list
      // item and longer than that just causes visual noise.
      updates.title = body.title === null ? null : String(body.title).slice(0, 200);
    }
    if (body.archivedAt !== undefined) {
      if (body.archivedAt === null) {
        updates.archivedAt = null;
      } else {
        const parsed = new Date(body.archivedAt);
        if (Number.isNaN(parsed.valueOf())) {
          return c.json({ error: "invalid archivedAt" }, 400);
        }
        updates.archivedAt = parsed;
      }
    }
    const [updated] = await deps.db
      .update(chatSessions)
      .set(updates)
      .where(eq(chatSessions.id, id))
      .returning();
    return c.json({ session: toResponse(updated!) });
  });

  // DELETE /chat/sessions/:id — soft delete by default (sets archived_at).
  // `?hard=1` permanently removes the session AND every agent_run that
  // belongs to its conversation (matched by the `OPENCARA_CHAT_SESSION_ID`
  // env marker the chat route bakes onto each turn — the same join the
  // /history endpoint uses). agent_run_logs cascade off agent_runs, so the
  // chat transcript goes too. This is the irreversible "Delete" the session
  // sidebar exposes (issue #153); the on-device ACP JSONL is simply no
  // longer addressable once the row is gone.
  r.delete("/chat/sessions/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const hard = c.req.query("hard") === "1";

    const row = await deps.db.query.chatSessions.findFirst({
      where: and(eq(chatSessions.id, id), eq(chatSessions.userId, user.id)),
    });
    if (!row) return c.json({ error: "not found" }, 404);

    if (hard) {
      // Refuse to hard-delete a session with an in-flight turn: the
      // agent_runs delete below would pull the row out from under a live
      // worker, whose subsequent log/status writes against that
      // agent_run_id would then fail and orphan the run. The caller can
      // Stop the run (or wait for it) and retry. Soft-delete/archive has
      // no such hazard, so it stays unconditional.
      const active = await selectActiveChatThreadKeys(deps.db, [row.threadKey]);
      if (active.has(row.threadKey)) {
        return c.json(
          { error: "session has an in-flight run; stop it before deleting" },
          409,
        );
      }
      // Drop the per-turn agent_runs first (logs cascade), then the
      // session row itself, so no orphaned history lingers under a
      // threadKey that can never be reached from the UI again. Both run
      // in one transaction so a mid-sequence failure can't leave the
      // session row pointing at a now-empty history (and vice versa).
      await deps.db.transaction(async (tx) => {
        await tx
          .delete(agentRuns)
          .where(
            sql`${agentRuns.spec}->'env'->>'OPENCARA_CHAT_SESSION_ID' = ${row.threadKey}`,
          );
        await tx.delete(chatSessions).where(eq(chatSessions.id, id));
      });
      return c.json({ ok: true, deleted: "hard" });
    }
    const now = new Date();
    await deps.db
      .update(chatSessions)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(chatSessions.id, id));
    return c.json({ ok: true, deleted: "soft" });
  });

  return r;
}
