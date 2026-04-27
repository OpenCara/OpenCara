import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { agents } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";

interface AgentRoutesDeps {
  db: Db;
}

const RUN_ON = new Set(["any", "local", "device"]);

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
    const rawCommand = String(body.command ?? "").trim();
    if (!name || !rawCommand) {
      return c.json({ error: "name and command required" }, 400);
    }
    // The UI exposes a single "Command" field that holds the full invocation
    // ("node /path/to/script.mjs --print"). The dispatcher still wants
    // command + args[], so tokenize on the way in. body.args is ignored.
    const { command, args } = tokenizeCommand(rawCommand);
    const env =
      body.env && typeof body.env === "object" && !Array.isArray(body.env)
        ? Object.fromEntries(
            Object.entries(body.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : {};
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;
    const runOn = RUN_ON.has(String(body.runOn))
      ? String(body.runOn)
      : "any";

    const id = ulid();
    try {
      await deps.db.insert(agents).values({
        id,
        userId: user.id,
        name,
        command,
        args,
        env,
        cwd,
        runOn,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("agents_user_name_uq")) {
        return c.json({ error: "name already in use" }, 409);
      }
      throw err;
    }
    return c.json(
      { agent: { id, userId: user.id, name, command, args, env, cwd, runOn } },
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
    if (typeof body.command === "string") {
      // Tokenize the full command line into command + args[]. body.args from
      // older clients is ignored — the single Command field is the source of
      // truth for both fields now.
      const { command, args } = tokenizeCommand(body.command.trim());
      updates.command = command;
      updates.args = args;
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
    if (RUN_ON.has(String(body.runOn))) updates.runOn = String(body.runOn);

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

  r.delete("/agents/:id", auth, async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    await deps.db.delete(agents).where(and(eq(agents.id, id), eq(agents.userId, user.id)));
    return c.body(null, 204);
  });

  return r;
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
