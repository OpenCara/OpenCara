import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import {
  PairingCreateRequestSchema,
  PairingConfirmRequestSchema,
} from "@openkira/shared";
import type { Db } from "../../db/client.js";
import { agentHosts, devicePairings } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { TokenCipher } from "../../auth/session.js";

interface DeviceRoutesDeps {
  db: Db;
  cipher: TokenCipher;
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

    await deps.db.insert(agentHosts).values({
      id: agentHostId,
      name: parsed.data.device_name,
      capabilities: [],
      userId: user.id,
      tokenHash,
    });
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
    return c.json({ devices: rows });
  });

  r.post("/:id/revoke", requireUser(), async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const row = await deps.db.query.agentHosts.findFirst({
      where: and(eq(agentHosts.id, id), eq(agentHosts.userId, user.id)),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    await deps.db
      .update(agentHosts)
      .set({ revokedAt: new Date(), tokenHash: null })
      .where(eq(agentHosts.id, id));
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
