import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  agents,
  flowNodeSettings,
  flows,
  prompts,
  projects,
} from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";

interface PromptRoutesDeps {
  db: Db;
}

export function promptRoutes(deps: PromptRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  // ─── Prompts CRUD ───────────────────────────────────────────

  r.get("/projects/:projectId/prompts", auth, async (c) => {
    const projectId = c.req.param("projectId");
    const rows = await deps.db
      .select()
      .from(prompts)
      .where(eq(prompts.projectId, projectId))
      .orderBy(desc(prompts.updatedAt));
    return c.json({ prompts: rows });
  });

  r.post("/projects/:projectId/prompts", auth, async (c) => {
    const projectId = c.req.param("projectId");
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name ?? "").trim();
    const promptBody = String(body.body ?? "").trim();
    if (!name || !promptBody) {
      return c.json({ error: "name and body required" }, 400);
    }
    const project = await deps.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) return c.json({ error: "project not found" }, 404);
    const id = ulid();
    try {
      await deps.db.insert(prompts).values({ id, projectId, name, body: promptBody });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("prompts_project_name_uq")) {
        return c.json({ error: "name already exists in this project" }, 409);
      }
      throw err;
    }
    return c.json(
      { prompt: { id, projectId, name, body: promptBody } },
      201,
    );
  });

  r.get("/prompts/:id", auth, async (c) => {
    const id = c.req.param("id");
    const row = await deps.db.query.prompts.findFirst({ where: eq(prompts.id, id) });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ prompt: row });
  });

  r.patch("/prompts/:id", auth, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const updates: Partial<typeof prompts.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.name === "string") updates.name = body.name.trim();
    if (typeof body.body === "string") updates.body = body.body;
    if (!updates.name && updates.body === undefined) {
      return c.json({ error: "no updates" }, 400);
    }
    try {
      await deps.db.update(prompts).set(updates).where(eq(prompts.id, id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("prompts_project_name_uq")) {
        return c.json({ error: "name already exists in this project" }, 409);
      }
      throw err;
    }
    const row = await deps.db.query.prompts.findFirst({ where: eq(prompts.id, id) });
    return c.json({ prompt: row });
  });

  r.delete("/prompts/:id", auth, async (c) => {
    const id = c.req.param("id");
    await deps.db.delete(prompts).where(eq(prompts.id, id));
    return c.body(null, 204);
  });

  // ─── Flow node settings (linkage) ───────────────────────────

  r.get("/projects/:projectId/flows/:flowId/node-settings", auth, async (c) => {
    const flowId = c.req.param("flowId");
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

      // Validate flow belongs to project, prompt belongs to project, agent belongs to user.
      const flow = await deps.db.query.flows.findFirst({
        where: and(eq(flows.id, flowId), eq(flows.projectId, projectId)),
      });
      if (!flow) return c.json({ error: "flow not found in project" }, 404);
      if (promptId && promptId !== "__keep__") {
        const p = await deps.db.query.prompts.findFirst({
          where: and(eq(prompts.id, promptId), eq(prompts.projectId, projectId)),
        });
        if (!p) return c.json({ error: "prompt not found in project" }, 404);
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
        await deps.db
          .update(flowNodeSettings)
          .set(patch)
          .where(eq(flowNodeSettings.id, existing.id));
        const merged = {
          ...existing,
          ...(promptId !== "__keep__" ? { promptId } : {}),
          ...(agentId !== "__keep__" ? { agentId } : {}),
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
          },
        },
        201,
      );
    },
  );

  return r;
}
