// Per-(user, scope) chat session lookups. Every page in the web app that
// opens the ChatPanel resolves a `(scopeKind, scopeId)` from its URL and
// auto-loads/creates a row here; the row's `threadKey` becomes the agent
// `--resume`/`--continue` session id, so re-opening the panel on the
// same scope picks up the same conversation.
//
//   scope_kind='project'  → scope_id=projectId   (gated by loadOwnedProject)
//   scope_kind='template' → scope_id=templateSlug (user-scoped already)
//   scope_kind='user'     → scope_id=''           (per-user, page-agnostic)
//
// Routes:
//   GET  /api/chat/sessions?scopeKind=…&scopeId=…
//   POST /api/chat/sessions       body { scopeKind, scopeId, agentId }

import { Hono } from "hono";
import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";
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
  scopeKind: ChatSessionScopeKind;
  scopeId: string;
  threadKey: string;
  agentId: string | null;
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
    scopeKind: row.scopeKind as ChatSessionScopeKind,
    scopeId: row.scopeId,
    threadKey: row.threadKey,
    agentId: row.agentId,
    updatedAt: row.updatedAt.toISOString(),
  };
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

    const existing = await deps.db.query.chatSessions.findFirst({
      where: and(
        eq(chatSessions.userId, user.id),
        eq(chatSessions.scopeKind, kind),
        eq(chatSessions.scopeId, scopeId),
      ),
    });
    if (existing) return c.json({ session: toResponse(existing) });

    const threadKey = `chat_${ulid()}`;
    const now = new Date();
    await deps.db.insert(chatSessions).values({
      userId: user.id,
      scopeKind: kind,
      scopeId,
      threadKey,
      agentId: null,
      updatedAt: now,
    });
    return c.json({
      session: {
        scopeKind: kind,
        scopeId,
        threadKey,
        agentId: null,
        updatedAt: now.toISOString(),
      } satisfies SessionResponse,
    });
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

    const existing = await deps.db.query.chatSessions.findFirst({
      where: and(
        eq(chatSessions.userId, user.id),
        eq(chatSessions.scopeKind, kind),
        eq(chatSessions.scopeId, scopeId),
      ),
    });

    const now = new Date();
    if (!existing) {
      const threadKey = `chat_${ulid()}`;
      await deps.db.insert(chatSessions).values({
        userId: user.id,
        scopeKind: kind,
        scopeId,
        threadKey,
        agentId,
        updatedAt: now,
      });
      return c.json({
        session: {
          scopeKind: kind,
          scopeId,
          threadKey,
          agentId,
          updatedAt: now.toISOString(),
        } satisfies SessionResponse,
      });
    }

    // Agent switch invalidates the cached ACP session: the new shim
    // hasn't created the prior session's JSONL on any device, so a
    // `--resume <prior-uuid>` would just error. Clear both columns
    // alongside the agentId write so the next turn starts fresh.
    // Unchanged agentId picks (e.g. POST replays the same value) skip
    // the clear so an in-flight resume doesn't get wiped under it.
    const agentChanged = existing.agentId !== agentId;
    await deps.db
      .update(chatSessions)
      .set({
        agentId,
        updatedAt: now,
        ...(agentChanged
          ? { acpSessionId: null, acpSessionHostId: null }
          : {}),
      })
      .where(
        and(
          eq(chatSessions.userId, user.id),
          eq(chatSessions.scopeKind, kind),
          eq(chatSessions.scopeId, scopeId),
        ),
      );

    return c.json({
      session: {
        scopeKind: kind,
        scopeId,
        threadKey: existing.threadKey,
        agentId,
        updatedAt: now.toISOString(),
      } satisfies SessionResponse,
    });
  });

  return r;
}
