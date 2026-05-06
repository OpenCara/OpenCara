import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "../../db/client.js";
import { agentHosts, agentRunLogs, agentRuns, agents } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import type { AgentDispatcher, LogStream } from "../../dispatch/dispatcher.js";
import { isAgentKind, type AgentKind } from "../../agents/kinds.js";

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

    // `kind` selects per-kind adapter (claude/codex/opencode/pi) or
    // falls back to legacy opaque-subprocess (`custom`). Older clients
    // that don't send the field default to `custom`.
    const kind: AgentKind = isAgentKind(body.kind) ? body.kind : "custom";

    // For kind=custom, we tokenize a free-form Command field as before.
    // For named kinds, the adapter builds the invocation at dispatch
    // time — the row's `command` is the kind label (informational only)
    // and `args` carries operator extras (e.g. `--provider X --model Y`
    // for pi). The UI sends `extraArgs` as a free-form string that we
    // tokenize the same way as a Command.
    let command: string;
    let args: string[];
    if (kind === "custom") {
      const rawCommand = String(body.command ?? "").trim();
      if (!name || !rawCommand) {
        return c.json({ error: "name and command required for kind=custom" }, 400);
      }
      ({ command, args } = tokenizeCommand(rawCommand));
    } else {
      if (!name) return c.json({ error: "name required" }, 400);
      command = kind;
      args = parseExtraArgs(body);
    }

    const env =
      body.env && typeof body.env === "object" && !Array.isArray(body.env)
        ? Object.fromEntries(
            Object.entries(body.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : {};
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;

    const hostIdRes = await resolveHostId(deps.db, user.id, body.hostId);
    if (!hostIdRes.ok) return c.json({ error: hostIdRes.error }, hostIdRes.status);

    const id = ulid();
    try {
      await deps.db.insert(agents).values({
        id,
        userId: user.id,
        name,
        kind,
        command,
        args,
        env,
        cwd,
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
          kind,
          command,
          args,
          env,
          cwd,
          hostId: hostIdRes.hostId,
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

    // Determine the effective kind for this update. If the body is
    // changing kind, use the new value; otherwise read the existing
    // row to know how to interpret command/extraArgs.
    let effectiveKind: AgentKind | undefined;
    if (body.kind !== undefined) {
      if (!isAgentKind(body.kind)) return c.json({ error: "invalid kind" }, 400);
      updates.kind = body.kind;
      effectiveKind = body.kind;
    }
    if (effectiveKind === undefined && (body.command !== undefined || body.extraArgs !== undefined)) {
      const existing = await deps.db.query.agents.findFirst({
        where: and(eq(agents.id, id), eq(agents.userId, user.id)),
      });
      effectiveKind = existing?.kind;
    }

    if (effectiveKind === "custom" && typeof body.command === "string") {
      const { command, args } = tokenizeCommand(body.command.trim());
      updates.command = command;
      updates.args = args;
    } else if (effectiveKind && effectiveKind !== "custom") {
      updates.command = effectiveKind;
      if (body.extraArgs !== undefined || body.command !== undefined) {
        updates.args = parseExtraArgs(body);
      }
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
    const spec = {
      kind: agent.name,
      command: agent.command,
      args: agent.args,
      env,
      cwd: agent.cwd ?? undefined,
    };

    const agentRunId = ulid();
    await deps.db.insert(agentRuns).values({
      id: agentRunId,
      spec,
      status: "running",
      flowRunStepId: null,
      startedAt: new Date(),
    });

    let seq = 0;
    // Drained via Promise.allSettled before flipping terminal status. We
    // assume the dispatcher fires every onLog before its run() promise
    // resolves — true for WebSocketDispatcher (resolves on the device's
    // `done` frame, which comes after every `log` frame).
    const logWrites: Promise<unknown>[] = [];
    const onLog = (stream: LogStream, chunk: string) => {
      const p = deps.db
        .insert(agentRunLogs)
        .values({ agentRunId, seq: seq++, stream, chunk })
        .then(() => deps.pg.notify("agent_run_logs", agentRunId))
        .catch((err: unknown) => {
          console.error("[agent-test] log persist failed", err);
        });
      logWrites.push(p);
    };

    void (async () => {
      try {
        const result = await deps.dispatcher.run(spec, {
          stdinJson: { message: prompt },
          onLog,
          hostId,
        });
        await Promise.allSettled(logWrites);
        await deps.db
          .update(agentRuns)
          .set({
            status: result.exitCode === 0 ? "succeeded" : "failed",
            exitCode: result.exitCode,
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, agentRunId));
      } catch (err) {
        console.error("[agent-test] dispatcher run failed", err);
        await Promise.allSettled(logWrites);
        await deps.db
          .update(agentRuns)
          .set({ status: "failed", finishedAt: new Date() })
          .where(eq(agentRuns.id, agentRunId));
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

/**
 * Split a shell-style command string into [command, ...args]. Honours single
 * and double quotes so users can include arguments with spaces, e.g.
 *   `node script.mjs --msg "hello world"`
 *   →  command="node", args=["script.mjs", "--msg", "hello world"]
 *
 * Backslash escapes are NOT supported — keep the surface area small. If a
 * user needs literal quotes, wrap the opposite quote style around them.
 */
/**
 * Pull "extra args" out of a request body, accepting either:
 * - `extraArgs` as a free-form string (tokenized like a Command field)
 * - `extraArgs` as a string array (already tokenized by the UI)
 * - Falls back to `body.command` (older clients send extras there).
 *
 * For named-kind agents this populates `agents.args`, which the per-
 * kind adapter appends to its base args at dispatch time.
 */
function parseExtraArgs(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.extraArgs)) {
    return body.extraArgs.map((s) => String(s));
  }
  if (typeof body.extraArgs === "string") {
    const trimmed = body.extraArgs.trim();
    if (!trimmed) return [];
    // Reuse tokenizeCommand by prefixing a dummy "command" so its
    // args[] result becomes our extra-args list.
    return tokenizeCommand(`_ ${trimmed}`).args;
  }
  if (typeof body.command === "string") {
    const trimmed = body.command.trim();
    if (!trimmed) return [];
    return tokenizeCommand(`_ ${trimmed}`).args;
  }
  return [];
}

export function tokenizeCommand(input: string): {
  command: string;
  args: string[];
} {
  const tokens: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;

  const flush = () => {
    if (inToken) {
      tokens.push(buf);
      buf = "";
      inToken = false;
    }
  };

  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
        inToken = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      flush();
      continue;
    }
    buf += ch;
    inToken = true;
  }
  flush();

  return {
    command: tokens[0] ?? "",
    args: tokens.slice(1),
  };
}

