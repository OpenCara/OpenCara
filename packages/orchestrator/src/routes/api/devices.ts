import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import {
  PairingCreateRequestSchema,
  PairingConfirmRequestSchema,
} from "@opencara/shared";
import type { Db } from "../../db/client.js";
import { agentHosts, devicePairings } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { TokenCipher } from "../../auth/session.js";
import type { DevicePool } from "../../dispatch/devices.js";

interface DeviceRoutesDeps {
  db: Db;
  cipher: TokenCipher;
  pool: DevicePool;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;
const CODE_LEN = 6;

export function deviceRoutes(deps: DeviceRoutesDeps) {
  const r = new Hono<AuthEnv>();

  // ─── Anonymous: pairing handshake ────────────────────────────

  r.post("/pairings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = PairingCreateRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);

    const code = generateCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await deps.db.insert(devicePairings).values({
      code,
      deviceSecretHash: parsed.data.device_secret_hash,
      status: "pending",
      expiresAt,
    });
    return c.json({ code, expires_at: expiresAt.toISOString() });
  });

  r.get("/pairings/:code/status", async (c) => {
    const code = c.req.param("code");
    const secret = c.req.query("secret") ?? "";
    const expectedHash = createHash("sha256").update(secret).digest("hex");

    const row = await deps.db.query.devicePairings.findFirst({
      where: eq(devicePairings.code, code),
    });
    if (!row || row.deviceSecretHash !== expectedHash) {
      return c.json({ error: "not found" }, 404);
    }
    if (row.expiresAt.getTime() < Date.now() && row.status === "pending") {
      await deps.db
        .update(devicePairings)
        .set({ status: "expired" })
        .where(eq(devicePairings.code, code));
      return c.json({ status: "expired" });
    }
    if (row.status !== "confirmed" || !row.deviceTokenEnc) {
      return c.json({ status: "pending" });
    }
    const token = deps.cipher.decrypt(row.deviceTokenEnc);
    await deps.db
      .update(devicePairings)
      .set({ deviceTokenEnc: null })
      .where(eq(devicePairings.code, code));
    return c.json({
      status: "confirmed",
      token,
      agent_host_id: row.agentHostId,
      device_name: row.deviceName,
    });
  });

  // ─── Signed-in: browser confirms a code ──────────────────────

  r.get("/pairings/:code", requireUser(), async (c) => {
    const code = c.req.param("code");
    const row = await deps.db.query.devicePairings.findFirst({
      where: eq(devicePairings.code, code),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({
      code: row.code,
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      deviceName: row.deviceName,
    });
  });

  r.post("/pairings/:code/confirm", requireUser(), async (c) => {
    const code = c.req.param("code");
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = PairingConfirmRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);

    const row = await deps.db.query.devicePairings.findFirst({
      where: eq(devicePairings.code, code),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status !== "pending") {
      return c.json({ error: `pairing ${row.status}` }, 409);
    }
    if (row.expiresAt.getTime() < Date.now()) {
      await deps.db
        .update(devicePairings)
        .set({ status: "expired" })
        .where(eq(devicePairings.code, code));
      return c.json({ error: "expired" }, 410);
    }

    const tokenPlain = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(tokenPlain).digest("hex");
    const agentHostId = ulid();

    try {
      await deps.db.insert(agentHosts).values({
        id: agentHostId,
        name: parsed.data.device_name,
        capabilities: [],
        userId: user.id,
        tokenHash,
      });
    } catch (err) {
      // Partial unique index `agent_hosts_user_name_uq` (per-user, only
      // among non-revoked rows) makes this firable when the user picks a
      // name they're already using. Surface as 409 so the pair page can
      // show "name taken — pick another" instead of a generic failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("agent_hosts_user_name_uq")) {
        return c.json({ error: "device name already in use" }, 409);
      }
      throw err;
    }
    await deps.db
      .update(devicePairings)
      .set({
        status: "confirmed",
        confirmedByUserId: user.id,
        deviceName: parsed.data.device_name,
        agentHostId,
        deviceTokenEnc: deps.cipher.encrypt(tokenPlain),
      })
      .where(eq(devicePairings.code, code));

    return c.json({ ok: true, agent_host_id: agentHostId });
  });

  // ─── Signed-in: list / revoke ────────────────────────────────

  r.get("/", requireUser(), async (c) => {
    const user = c.get("user")!;
    const rows = await deps.db
      .select()
      .from(agentHosts)
      .where(eq(agentHosts.userId, user.id))
      .orderBy(desc(agentHosts.createdAt));
    const devices = rows.map((row) => ({ ...row, online: deps.pool.isConnected(row.id) }));
    return c.json({ devices });
  });

  r.post("/:id/revoke", requireUser(), async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const row = await deps.db.query.agentHosts.findFirst({
      where: and(eq(agentHosts.id, id), eq(agentHosts.userId, user.id)),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    // Kick any live WS first so the remote `opencara run` notices the
    // revocation immediately instead of waiting for its next ping/reconnect
    // attempt to fail auth.
    deps.pool.disconnect(id);
    // Hard delete. agent_runs.host_id and device_pairings.agent_host_id are
    // ON DELETE SET NULL so historical rows survive without the FK target.
    await deps.db
      .delete(agentHosts)
      .where(and(eq(agentHosts.id, id), eq(agentHosts.userId, user.id)));
    return c.body(null, 204);
  });

  return r;
}

function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = randomBytes(CODE_LEN);
  for (let i = 0; i < CODE_LEN; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}
