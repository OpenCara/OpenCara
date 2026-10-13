import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "../../db/client.js";
import { agentHosts, agentRuns, agents } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import type { AgentDispatcher } from "../../dispatch/dispatcher.js";
import { AgentLogSink } from "../../agents/logSink.js";
import { buildAgentSpec } from "../../agents/agentSpec.js";
import { isThinkingLevel, parseModelRef, THINKING_LEVELS } from "@opencara/shared";

interface AgentRoutesDeps {
  db: Db;
  pg: Sql;
  dispatcher: AgentDispatcher;
}

export function agentRoutes(deps: AgentRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  r.get("/agents", auth, async (c) => {
    const user = c.get("user")!;
    const rows = await deps.db
      .select()
      .from(agents)
      .where(eq(agents.userId, user.id))
      .orderBy(desc(agents.updatedAt));
    return c.json({ agents: rows });
  });

  r.post("/agents", auth, async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name ?? "").trim();

    if (!name) return c.json({ error: "name required" }, 400);
    const model = parseModel(body.model);
    if (model === null) return c.json({ error: MODEL_ERROR }, 400);
    const thoughtLevel = parseThoughtLevel(body.thoughtLevel);
    if (thoughtLevel === undefined) return c.json({ error: THOUGHT_LEVEL_ERROR }, 400);

    const env =
      body.env && typeof body.env === "object" && !Array.isArray(body.env)
        ? Object.fromEntries(
            Object.entries(body.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : {};
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;
    // Absent → the column default (capture). Only an explicit `false` opts out.
    const captureThinking = body.captureThinking !== false;

    const hostIdRes = await resolveHostId(deps.db, user.id, body.hostId);
    if (!hostIdRes.ok) return c.json({ error: hostIdRes.error }, hostIdRes.status);

    const id = ulid();
    try {
      await deps.db.insert(agents).values({
        id,
        userId: user.id,
        name,
        model,
        env,
        cwd,
        captureThinking,
        thoughtLevel,
        hostId: hostIdRes.hostId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("agents_user_name_uq")) {
        return c.json({ error: "name already in use" }, 409);
      }
      throw err;
    }
    return c.json(
      {
        agent: {
          id,
          userId: user.id,
          name,
          model,
          thoughtLevel,
          captureThinking,
          env,
          cwd,
          hostId: hostIdRes.hostId,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      201,
    );
  });

  r.get("/agents/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const row = await deps.db.query.agents.findFirst({
      where: and(eq(agents.id, id), eq(agents.userId, user.id)),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ agent: row });
  });

  r.patch("/agents/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const updates: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.name === "string") updates.name = body.name.trim();

    if (body.model !== undefined) {
      const model = parseModel(body.model);
      if (model === null) return c.json({ error: MODEL_ERROR }, 400);
      updates.model = model;
    }
    if (body.env && typeof body.env === "object" && !Array.isArray(body.env)) {
      updates.env = Object.fromEntries(
        Object.entries(body.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
    if (typeof body.cwd === "string") {
      updates.cwd = body.cwd.trim() || null;
    } else if (body.cwd === null) {
      updates.cwd = null;
    }
    // Absent → unchanged. Only a real boolean moves it, so a body that omits
    // the field (every pre-existing client) can't silently flip the switch.
    if (typeof body.captureThinking === "boolean") {
      updates.captureThinking = body.captureThinking;
    }
    // Absent → unchanged; "" / null → clear (the device's pi default); else set.
    if (body.thoughtLevel !== undefined) {
      const thoughtLevel = parseThoughtLevel(body.thoughtLevel);
      if (thoughtLevel === undefined) return c.json({ error: THOUGHT_LEVEL_ERROR }, 400);
      updates.thoughtLevel = thoughtLevel;
    }
    if (body.hostId !== undefined) {
      const hostIdRes = await resolveHostId(deps.db, user.id, body.hostId);
      if (!hostIdRes.ok) return c.json({ error: hostIdRes.error }, hostIdRes.status);
      updates.hostId = hostIdRes.hostId;
    }

    try {
      await deps.db
        .update(agents)
        .set(updates)
        .where(and(eq(agents.id, id), eq(agents.userId, user.id)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("agents_user_name_uq")) {
        return c.json({ error: "name already in use" }, 409);
      }
      throw err;
    }
    const row = await deps.db.query.agents.findFirst({
      where: and(eq(agents.id, id), eq(agents.userId, user.id)),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ agent: row });
  });

  // Smoke-test an agent with a prompt; returns agentRunId for SSE tail.
  r.post("/agents/:id/test", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) return c.json({ error: "prompt required" }, 400);

    const agent = await deps.db.query.agents.findFirst({
      where: and(eq(agents.id, id), eq(agents.userId, user.id)),
    });
    if (!agent) return c.json({ error: "agent not found" }, 404);

    // Test override: pin this run to a specific device. `hostId: null` in
    // the body explicitly means "any idle device" (overriding the saved
    // pin); `hostId` undefined means "fall back to the saved pin".
    const hasOverride = "hostId" in body;
    let hostId: string | null = agent.hostId ?? null;
    if (hasOverride) {
      const hostIdRes = await resolveHostId(deps.db, user.id, body.hostId);
      if (!hostIdRes.ok) return c.json({ error: hostIdRes.error }, hostIdRes.status);
      hostId = hostIdRes.hostId;
    }

    const env: Record<string, string> = {
      ...agent.env,
      OPENCARA_TEST: "1",
    };

    const spec = buildAgentSpec({
      agent,
      env,
      systemPromptMd:
        "You are an opencara chat agent being exercised via the dashboard's Test button. " +
        "Respond to the user's prompt directly.",
      userPromptMd: prompt,
    });

    const agentRunId = ulid();
    await deps.db.insert(agentRuns).values({
      id: agentRunId,
      spec,
      status: "running",
      flowRunStepId: null,
      // Test runs have no project, so the run-log gate falls back to
      // direct attribution. Without this the "Test" button dispatches
      // successfully but its log stream returns 404.
      addedByUserId: user.id,
      startedAt: new Date(),
    });

    // Batched log persistence — one insert+notify per flush instead of two
    // pool checkouts per chunk (see AgentLogSink / OpenCara#245).
    const logSink = new AgentLogSink(deps.db, deps.pg, agentRunId);

    void (async () => {
      try {
        const result = await deps.dispatcher.run(spec, {
          runId: agentRunId,
          onLog: logSink.push,
          hostId,
        });
        // Drain buffered chunks before the terminal write — the SSE end
        // event goes out on the status flip, so the tail must be durable.
        await logSink.close();
        // First terminal write wins — see the matching guard in chat.ts.
        // Test runs are cancellable via the same /chat/messages/:runId/
        // cancel route, so the same overwrite race applies here.
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
      } catch (err) {
        console.error("[agent-test] dispatcher run failed", err);
        await logSink.close();
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
      // Final notify so the SSE stream sees the terminal state.
      void deps.pg.notify("agent_run_logs", agentRunId);
    })();

    return c.json({ agentRunId });
  });

  r.delete("/agents/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    await deps.db.delete(agents).where(and(eq(agents.id, id), eq(agents.userId, user.id)));
    return c.body(null, 204);
  });

  return r;
}

interface HostIdResolved {
  ok: true;
  hostId: string | null;
}
interface HostIdError {
  ok: false;
  status: 400 | 404;
  error: string;
}

/**
 * Validate a `hostId` from the request body. Accepts undefined, null, or a
 * string. Strings must reference a non-revoked agent_host owned by this
 * user. The "any idle device" sentinel is null.
 */
async function resolveHostId(
  db: Db,
  userId: string,
  raw: unknown,
): Promise<HostIdResolved | HostIdError> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, hostId: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, status: 400, error: "hostId must be a string or null" };
  }
  const row = await db.query.agentHosts.findFirst({
    where: and(
      eq(agentHosts.id, raw),
      eq(agentHosts.userId, userId),
      isNull(agentHosts.revokedAt),
    ),
  });
  if (!row) {
    return { ok: false, status: 404, error: "device not found or not yours" };
  }
  return { ok: true, hostId: raw };
}

const MODEL_ERROR = "model must be <provider>/<modelId>";
const THOUGHT_LEVEL_ERROR = `thoughtLevel must be one of ${THINKING_LEVELS.join(", ")}, or null`;

/** A trimmed `<provider>/<modelId>` reference, or null when invalid. */
function parseModel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const model = raw.trim();
  return parseModelRef(model) ? model : null;
}

/**
 * A thinking level, null for the device's pi default (absent / null / ""), or
 * undefined when the value isn't one of `THINKING_LEVELS`.
 */
function parseThoughtLevel(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const level = raw.trim();
  if (!level) return null;
  return isThinkingLevel(level) ? level : undefined;
}
