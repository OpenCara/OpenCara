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
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  CHAT_SESSION_SCOPE_KINDS,
  type ChatSessionScopeKind,
  chatSessions,
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
  // 'user' scope: no extra check beyond auth.
  return { ok: true };
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
    if (existing) return c.json({ session: toResponse(existing) });

    const id = `chat_${ulid()}`;
    const threadKey = id;
    const now = new Date();
    const [created] = await deps.db
      .insert(chatSessions)
      .values({
        id,
        userId: user.id,
        scopeKind: kind,
        scopeId,
        threadKey,
        agentId: null,
        updatedAt: now,
      })
      .returning();
    return c.json({ session: toResponse(created!) });
  });

  // POST /chat/sessions — upsert the agent pick for the (user, scope).
  // Body: { scopeKind, scopeId, agentId }. agentId may be null.
  r.post("/chat/sessions", auth, async (c) => {
    const user = c.get("user")!;
    const body = (await c.req.json().catch(() => ({}))) as {
      scopeKind?: string;
      scopeId?: string;
      agentId?: string | null;
    };
    const kind = parseScopeKind(body.scopeKind);
    if (!kind) return c.json({ error: "invalid scopeKind" }, 400);
    const scopeId = normalizedScopeId(kind, body.scopeId ?? "");
    const agentId = body.agentId ?? null;

    const gate = await gateScope(deps, user.id, kind, scopeId);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);

    const existing = await findActiveSession(deps, user.id, kind, scopeId);

    const now = new Date();
    if (!existing) {
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
          agentId,
          updatedAt: now,
        })
        .returning();
      return c.json({ session: toResponse(created!) });
    }

    // Agent switch invalidates the cached ACP session: the new shim
    // hasn't created the prior session's JSONL on any device, so a
    // `--resume <prior-uuid>` would just error. Clear both columns
    // alongside the agentId write so the next turn starts fresh.
    // Unchanged agentId picks (e.g. POST replays the same value) skip
    // the clear so an in-flight resume doesn't get wiped under it.
    const agentChanged = existing.agentId !== agentId;
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
    return c.json({ sessions: rows.map(toResponse) });
  });

  // POST /chat/sessions/new — "New chat" button. Archives the current
  // active row (if any) and inserts a fresh one; returns the new row.
  // The fresh row's id IS its threadKey so chat.ts's existing resume
  // lookup (by threadKey) keeps working unchanged.
  //
  // Optional `agentId` lets the panel persist the user's current agent
  // pick onto the new row in the same trip — saves a follow-up POST
  // /chat/sessions just to set it.
  r.post("/chat/sessions/new", auth, async (c) => {
    const user = c.get("user")!;
    const body = (await c.req.json().catch(() => ({}))) as {
      scopeKind?: string;
      scopeId?: string;
      agentId?: string | null;
    };
    const kind = parseScopeKind(body.scopeKind);
    if (!kind) return c.json({ error: "invalid scopeKind" }, 400);
    const scopeId = normalizedScopeId(kind, body.scopeId ?? "");
    const agentId = body.agentId ?? null;

    const gate = await gateScope(deps, user.id, kind, scopeId);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);

    const now = new Date();
    // Archive the currently-active row, if any. Done in a separate
    // statement (not a transaction) — a race where two browsers click
    // "New chat" simultaneously leaves both prior actives archived
    // and two fresh rows in their place; the next GET picks the
    // most-recently-updated one. Slightly wasteful but correct.
    const existing = await findActiveSession(deps, user.id, kind, scopeId);
    if (existing) {
      await deps.db
        .update(chatSessions)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(chatSessions.id, existing.id));
    }

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
        agentId,
        updatedAt: now,
      })
      .returning();
    return c.json({ session: toResponse(created!) });
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
  // `?hard=1` removes the row outright; useful for clearing a noisy
  // history but loses the link to the on-device ACP JSONL (the file
  // itself isn't deleted, just no longer addressable from the UI).
  r.delete("/chat/sessions/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const hard = c.req.query("hard") === "1";

    const row = await deps.db.query.chatSessions.findFirst({
      where: and(eq(chatSessions.id, id), eq(chatSessions.userId, user.id)),
    });
    if (!row) return c.json({ error: "not found" }, 404);

    if (hard) {
      await deps.db.delete(chatSessions).where(eq(chatSessions.id, id));
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
