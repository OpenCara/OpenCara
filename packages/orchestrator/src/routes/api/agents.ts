import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "../../db/client.js";
import { agentHosts, agentRunLogs, agentRuns, agents } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import type { AgentDispatcher, LogStream } from "../../dispatch/dispatcher.js";
import { isAgentKind, type AgentKind } from "../../agents/kinds.js";
import {
  acpCommandFor,
  buildAcpSpec,
  checkAcpEligibility,
  defaultAcpArgsFor,
} from "../../agents/acp-gate.js";
import type { AgentSpec } from "@opencara/shared";

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
    return c.json({ agents: rows.map(serializeAgent) });
  });

  r.post("/agents", auth, async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name ?? "").trim();

    // `kind` must be one of the supported ACP kinds. Pre-#30 the
    // dashboard accepted `custom` as an opaque-subprocess escape
    // hatch; the cutover removed that path. Reject unknown / missing
    // kind explicitly with a clear conversion hint.
    if (!isAgentKind(body.kind)) {
      return c.json(
        {
          error:
            'kind required and must be one of "claude", "codex", "opencode", "pi". ' +
            'The "custom" kind was removed in the v0.30 cutover.',
        },
        400,
      );
    }
    const kind: AgentKind = body.kind;

    if (!name) return c.json({ error: "name required" }, 400);
    // The agent row's `command` and `args` are now retained for legacy
    // diagnostics only — the ACP adapter is selected by kind in
    // `acp-gate.ts`. Operators don't need to fill these in; we accept
    // whatever the dashboard sends and persist it untouched.
    const command = typeof body.command === "string" ? body.command.trim() : kind;
    const args = parseExtraArgs(body);
    // undefined (field absent) defaults to null on create.
    const acpArgs = parseAcpArgs(body) ?? null;

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
        acpArgs,
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
        agent: serializeAgent({
          id,
          userId: user.id,
          name,
          kind,
          command,
          args,
          acpArgs,
          env,
          cwd,
          hostId: hostIdRes.hostId,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
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
    return c.json({ agent: serializeAgent(row) });
  });

  r.patch("/agents/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const updates: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.name === "string") updates.name = body.name.trim();

    // Kind must be a registered ACP kind. If the body changes it,
    // validate; pre-#30 `custom` rows survive in the DB (the Postgres
    // enum still has the value) but can't be saved/created/dispatched
    // anymore. Operators should pick a registered kind.
    if (body.kind !== undefined) {
      if (!isAgentKind(body.kind)) return c.json({ error: "invalid kind" }, 400);
      updates.kind = body.kind;
    }
    // command + args are retained on the row for legacy diagnostics
    // only — dispatch ignores them in favour of the per-kind ACP
    // adapter. We persist whatever the dashboard sends.
    if (typeof body.command === "string") {
      const trimmed = body.command.trim();
      updates.command = trimmed.length > 0 ? trimmed : (updates.kind ?? "");
    }
    if (body.extraArgs !== undefined) {
      updates.args = parseExtraArgs(body);
    }
    // acpArgs: absent → unchanged; null/empty → reset to kind default; else override.
    const acpArgs = parseAcpArgs(body);
    if (acpArgs !== undefined) {
      updates.acpArgs = acpArgs;
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
    return c.json({ agent: serializeAgent(row) });
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

    // ACP eligibility — same gate as chat.ts. Unsupported kinds get
    // a 400 with a conversion hint; everything else dispatches via ACP.
    const eligibility = checkAcpEligibility(agent.kind);
    if (eligibility.refuseReason) {
      return c.json({ error: eligibility.refuseReason }, 400);
    }
    const spec: AgentSpec = buildAcpSpec({
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
          runId: agentRunId,
          onLog,
          hostId,
        });
        await Promise.allSettled(logWrites);
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
        await Promise.allSettled(logWrites);
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

/**
 * Parse the `acpArgs` override from a request body. Returns:
 * - `undefined` when the field is absent (PATCH leaves the column unchanged),
 * - `null` to reset to the kind default (explicit null, or an empty value),
 * - `string[]` for an override (array as-is, or a shell string tokenized).
 */
function parseAcpArgs(body: Record<string, unknown>): string[] | null | undefined {
  if (!("acpArgs" in body)) return undefined;
  const raw = body.acpArgs;
  if (raw === null) return null;
  let arr: string[];
  if (Array.isArray(raw)) {
    arr = raw.map((s) => String(s));
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    arr = trimmed ? tokenizeCommand(`_ ${trimmed}`).args : [];
  } else {
    return null;
  }
  // An empty override is meaningless (the command alone won't run) — treat it
  // as "reset to default" so the UI's clear/reset path lands as NULL.
  return arr.length > 0 ? arr : null;
}

/**
 * Shape an agent row for the API, adding the computed `acpCommand` (the fixed,
 * kind-derived adapter executable) and `defaultAcpArgs` (what runs by default
 * for this kind + the agent's `args`). The UI shows the command read-only and
 * pre-fills the editable args field with `acpArgs ?? defaultAcpArgs`.
 */
function serializeAgent(row: typeof agents.$inferSelect) {
  return {
    ...row,
    acpCommand: acpCommandFor(row.kind) ?? row.command,
    defaultAcpArgs: defaultAcpArgsFor(row.kind, row.args) ?? row.args,
  };
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

