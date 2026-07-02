import { createHash, randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import {
  DEVICE_TO_SERVER_TYPES,
  DeviceToServerMessageSchema,
  HOST_PROTOCOL_VERSION,
  MIN_HOST_PROTOCOL_VERSION,
  WS_CLOSE_PROTOCOL_TOO_OLD,
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
            // Old CLIs strip unknown keys, so advertising this is safe;
            // new CLIs use it to log a version-skew warning.
            protocolVersion: HOST_PROTOCOL_VERSION,
          }),
        );
        console.log(`[device-ws] ${host.name} (${host.id}) connected`);
      },
      onMessage(
        evt: { data: string | { toString(): string } },
        ws: { close: (code?: number, reason?: string) => void },
      ) {
        const raw = typeof evt.data === "string" ? evt.data : evt.data.toString();
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          console.error(
            "[device-ws] non-JSON frame from",
            host.name,
            "preview:",
            raw.slice(0, 200),
          );
          return;
        }
        // Forward-compat: a frame type this server doesn't know means the
        // DEVICE is newer — ignore it quietly instead of error-logging every
        // occurrence as corruption.
        const frameType =
          typeof json === "object" && json !== null && "type" in json
            ? (json as { type: unknown }).type
            : undefined;
        if (typeof frameType === "string" && !DEVICE_TO_SERVER_TYPES.has(frameType)) {
          console.log(
            `[device-ws] ignoring unknown frame type "${frameType}" from ${host.name} (CLI newer than server?)`,
          );
          return;
        }
        let parsed: DeviceToServerMessage;
        try {
          parsed = DeviceToServerMessageSchema.parse(json);
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
          // Protocol floor: hellos below MIN_HOST_PROTOCOL_VERSION are
          // rejected with a close code the CLI treats as fatal (no
          // reconnect storm) and a human-readable upgrade hint. Absent
          // protocolVersion = pre-versioning CLI = 0.
          const deviceProtocol = parsed.protocolVersion ?? 0;
          if (deviceProtocol < MIN_HOST_PROTOCOL_VERSION) {
            console.warn(
              `[device-ws] rejecting ${host.name}: protocol v${deviceProtocol} < server floor v${MIN_HOST_PROTOCOL_VERSION} (CLI ${parsed.version})`,
            );
            ws.close(
              WS_CLOSE_PROTOCOL_TOO_OLD,
              `device protocol v${deviceProtocol} is below the server minimum v${MIN_HOST_PROTOCOL_VERSION}; upgrade with: npm i -g opencara`,
            );
            return;
          }
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
