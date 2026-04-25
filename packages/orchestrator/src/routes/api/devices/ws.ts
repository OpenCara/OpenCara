import { createHash } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import {
  DeviceToServerMessageSchema,
  type DeviceToServerMessage,
} from "@openkira/shared";
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

    let registered = false;
    return {
      onOpen(_evt: unknown, ws: { send: (msg: string) => void }) {
        deps.pool.register({
          agentHostId: host.id,
          userId: host.userId,
          // The WS context shape varies; cast for the pool's needs.
          ws: ws as never,
          busy: false,
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
        let parsed: DeviceToServerMessage;
        try {
          const raw = typeof evt.data === "string" ? evt.data : evt.data.toString();
          parsed = DeviceToServerMessageSchema.parse(JSON.parse(raw));
        } catch (err) {
          console.error("[device-ws] invalid frame", err);
          return;
        }
        if (parsed.type === "hello") {
          void deps.db
            .update(agentHosts)
            .set({ platform: parsed.platform, version: parsed.version })
            .where(eq(agentHosts.id, host.id));
          return;
        }
        deps.pool.handleMessage(host.id, parsed);
      },
      onClose() {
        if (registered) deps.pool.unregister(host.id);
        console.log(`[device-ws] ${host.name} (${host.id}) disconnected`);
      },
    };
  };
}
