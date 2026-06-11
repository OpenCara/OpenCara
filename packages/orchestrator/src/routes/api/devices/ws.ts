import { createHash, randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import {
  DeviceToServerMessageSchema,
  type DeviceToServerMessage,
} from "@opencara/shared";
import type { Db } from "../../../db/client.js";
import { agentHosts } from "../../../db/schema.js";
import type { DevicePool } from "../../../dispatch/devices.js";

export interface DeviceWsDeps {
  db: Db;
  pool: DevicePool;
}

/**
 * Handler factory passed to upgradeWebSocket(). The Hono context (c) is
 * available in the outer closure for header inspection (auth bearer).
 */
export function deviceWsHandler(deps: DeviceWsDeps) {
  return async (c: { req: { header: (n: string) => string | undefined } }) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const tokenHash = token
      ? createHash("sha256").update(token).digest("hex")
      : "";
    const host = tokenHash
      ? await deps.db.query.agentHosts.findFirst({
          where: (h, { and, eq }) =>
            and(eq(h.tokenHash, tokenHash), isNull(h.revokedAt)),
        })
      : null;

    if (!host) {
      return {
        onOpen(_evt: unknown, ws: { close: (code?: number, reason?: string) => void }) {
          ws.close(1008, "unauthorized");
        },
        onMessage() {},
        onClose() {},
      };
    }

    // Per-connection identity. Lets the pool tell THIS socket apart from a
    // later reconnection under the same host id, so a stale socket's late
    // close can't evict the live one. See ConnectedDevice.connId.
    const connId = randomUUID();
    let registered = false;
    return {
      onOpen(_evt: unknown, ws: { send: (msg: string) => void }) {
        deps.pool.register({
          agentHostId: host.id,
          connId,
          userId: host.userId,
          isAlive: true,
          // The WS context shape varies; cast for the pool's needs.
          ws: ws as never,
          inflight: new Set<string>(),
        });
        registered = true;
        ws.send(
          JSON.stringify({
            type: "hello-ack",
            agentHostId: host.id,
            deviceName: host.name,
          }),
        );
        console.log(`[device-ws] ${host.name} (${host.id}) connected`);
      },
      onMessage(evt: { data: string | { toString(): string } }) {
        const raw = typeof evt.data === "string" ? evt.data : evt.data.toString();
        let parsed: DeviceToServerMessage;
        try {
          parsed = DeviceToServerMessageSchema.parse(JSON.parse(raw));
        } catch (err) {
          console.error(
            "[device-ws] invalid frame from",
            host.name,
            "preview:",
            raw.slice(0, 200),
            "err:",
            err instanceof Error ? err.message : err,
          );
          return;
        }
        if (parsed.type === "hello") {
          console.log(
            `[device-ws] hello from ${host.name}: platform=${parsed.platform} version=${parsed.version} systemInfo=${parsed.systemInfo ? "yes" : "no"}`,
          );
          const updates: Partial<typeof agentHosts.$inferInsert> = {
            platform: parsed.platform,
            version: parsed.version,
          };
          if (parsed.systemInfo) {
            updates.systemInfo = parsed.systemInfo;
            updates.systemInfoUpdatedAt = new Date();
          }
          // Await + catch so a DB error surfaces rather than getting swallowed
          // by the prior fire-and-forget pattern.
          void deps.db
            .update(agentHosts)
            .set(updates)
            .where(eq(agentHosts.id, host.id))
            .then(() => {
              console.log(`[device-ws] persisted hello for ${host.name}`);
            })
            .catch((err: unknown) => {
              console.error(`[device-ws] hello persist failed for ${host.name}`, err);
            });
          return;
        }
        deps.pool.handleMessage(host.id, parsed);
      },
      onClose() {
        // connId-scoped: if the device already reconnected under a fresh
        // socket, this stale close is a no-op against the live registration.
        if (registered) deps.pool.unregister(host.id, connId);
        console.log(`[device-ws] ${host.name} (${host.id}) disconnected`);
      },
    };
  };
}
