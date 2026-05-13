import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  agents,
  flowNodeSettings,
  flows,
  prompts,
} from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { loadOwnedProject } from "../../auth/ownership.js";

interface PromptRoutesDeps {
  db: Db;
}

/**
 * Prompts are user-scoped (matching the per-user agents library). Linking a
 * prompt to a flow node only requires that the prompt belong to the same
 * user that owns the agent, not the same project — flow node settings are
 * still keyed by (projectId, flowId, nodeId) for storage but the prompt/
 * agent references can resolve cross-project.
 */
export function promptRoutes(deps: PromptRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  // ─── Prompts CRUD ───────────────────────────────────────────

  r.get("/prompts", auth, async (c) => {
    const user = c.get("user")!;
    const rows = await deps.db
      .select()
      .from(prompts)
      .where(eq(prompts.userId, user.id))
      .orderBy(desc(prompts.updatedAt));
    return c.json({ prompts: rows });
  });

  r.post("/prompts", auth, async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name ?? "").trim();
    const promptBody = String(body.body ?? "").trim();
    const labels = sanitizeLabels(body.labels);
    if (!name || !promptBody) {
      return c.json({ error: "name and body required" }, 400);
    }
    const id = ulid();
    try {
      await deps.db.insert(prompts).values({
        id,
        userId: user.id,
        name,
        body: promptBody,
        labels,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("prompts_user_name_uq")) {
        return c.json({ error: "name already in use" }, 409);
      }
      throw err;
    }
    return c.json(
      { prompt: { id, userId: user.id, name, body: promptBody, labels } },
      201,
    );
  });

  r.get("/prompts/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const row = await deps.db.query.prompts.findFirst({
      where: and(eq(prompts.id, id), eq(prompts.userId, user.id)),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ prompt: row });
  });

  r.patch("/prompts/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const updates: Partial<typeof prompts.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.name === "string") updates.name = body.name.trim();
    if (typeof body.body === "string") updates.body = body.body;
    if (Array.isArray(body.labels)) updates.labels = sanitizeLabels(body.labels);
    if (
      updates.name === undefined &&
      updates.body === undefined &&
      updates.labels === undefined
    ) {
      return c.json({ error: "no updates" }, 400);
    }
    try {
      await deps.db
        .update(prompts)
        .set(updates)
        .where(and(eq(prompts.id, id), eq(prompts.userId, user.id)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("prompts_user_name_uq")) {
        return c.json({ error: "name already in use" }, 409);
      }
      throw err;
    }
    const row = await deps.db.query.prompts.findFirst({
      where: and(eq(prompts.id, id), eq(prompts.userId, user.id)),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ prompt: row });
  });

  r.delete("/prompts/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    await deps.db
      .delete(prompts)
      .where(and(eq(prompts.id, id), eq(prompts.userId, user.id)));
    return c.body(null, 204);
  });

  // ─── Flow node settings (linkage) ───────────────────────────

  r.get("/projects/:projectId/flows/:flowId/node-settings", auth, async (c) => {
    const user = c.get("user")!;
    const projectId = c.req.param("projectId");
    const flowId = c.req.param("flowId");
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "flow not found in project" }, 404);
    const rows = await deps.db
      .select()
      .from(flowNodeSettings)
      .where(eq(flowNodeSettings.flowId, flowId));
    return c.json({ settings: rows });
  });

  r.put(
    "/projects/:projectId/flows/:flowId/nodes/:nodeId/settings",
    auth,
    async (c) => {
      const user = c.get("user")!;
      const projectId = c.req.param("projectId");
      const flowId = c.req.param("flowId");
      const nodeId = c.req.param("nodeId");
      const body = await c.req.json().catch(() => ({}));
      const promptIdRaw = body.promptId;
      const promptId =
        promptIdRaw === undefined
          ? "__keep__"
          : promptIdRaw === null
            ? null
            : String(promptIdRaw);
      const agentIdRaw = body.agentId;
      const agentId =
        agentIdRaw === undefined
          ? "__keep__"
          : agentIdRaw === null
            ? null
            : String(agentIdRaw);
      const labelRaw = body.label;
      const label: string | null | "__keep__" =
        labelRaw === undefined
          ? "__keep__"
          : labelRaw === null
            ? null
            : String(labelRaw).trim() || null;

      // Project must belong to the caller; flow must belong to the project;
      // prompt + agent must belong to the current user (cross-project allowed
      // since both libraries are user-scoped now).
      const owned = await loadOwnedProject(deps.db, projectId, user.id);
      if (!owned) return c.json({ error: "flow not found in project" }, 404);
      const flow = await deps.db.query.flows.findFirst({
        where: and(eq(flows.id, flowId), eq(flows.projectId, projectId)),
      });
      if (!flow) return c.json({ error: "flow not found in project" }, 404);
      if (promptId && promptId !== "__keep__") {
        const p = await deps.db.query.prompts.findFirst({
          where: and(eq(prompts.id, promptId), eq(prompts.userId, user.id)),
        });
        if (!p) return c.json({ error: "prompt not found" }, 404);
      }
      if (agentId && agentId !== "__keep__") {
        const a = await deps.db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.userId, user.id)),
        });
        if (!a) return c.json({ error: "agent not found" }, 404);
      }

      const existing = await deps.db.query.flowNodeSettings.findFirst({
        where: and(
          eq(flowNodeSettings.flowId, flowId),
          eq(flowNodeSettings.nodeId, nodeId),
        ),
      });
      if (existing) {
        const patch: Partial<typeof flowNodeSettings.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (promptId !== "__keep__") patch.promptId = promptId;
        if (agentId !== "__keep__") patch.agentId = agentId;
        if (label !== "__keep__") patch.label = label;
        await deps.db
          .update(flowNodeSettings)
          .set(patch)
          .where(eq(flowNodeSettings.id, existing.id));
        const merged = {
          ...existing,
          ...(promptId !== "__keep__" ? { promptId } : {}),
          ...(agentId !== "__keep__" ? { agentId } : {}),
          ...(label !== "__keep__" ? { label } : {}),
          updatedAt: new Date().toISOString(),
        };
        return c.json({ setting: merged });
      }
      const id = ulid();
      await deps.db.insert(flowNodeSettings).values({
        id,
        projectId,
        flowId,
        nodeId,
        promptId: promptId === "__keep__" ? null : promptId,
        agentId: agentId === "__keep__" ? null : agentId,
        label: label === "__keep__" ? null : label,
      });
      return c.json(
        {
          setting: {
            id,
            projectId,
            flowId,
            nodeId,
            promptId: promptId === "__keep__" ? null : promptId,
            agentId: agentId === "__keep__" ? null : agentId,
            label: label === "__keep__" ? null : label,
          },
        },
        201,
      );
    },
  );

  return r;
}

/**
 * Normalise the labels array: trim, drop empties, dedupe (case-insensitive),
 * cap to 24 entries to keep the UI sane. Anything non-string is dropped.
 */
function sanitizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 24) break;
  }
  return out;
}
