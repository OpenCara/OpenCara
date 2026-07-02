import WebSocket from "ws";
import {
  DeviceToServerMessageSchema,
  SERVER_TO_DEVICE_TYPES,
  ServerToDeviceMessageSchema,
  WS_CLOSE_PROTOCOL_TOO_OLD,
  type DeviceToServerMessage,
  type ServerToDeviceMessage,
} from "@opencara/shared";

/**
 * Classify a raw server frame. Exported for tests.
 *
 * - `ok`: parsed, dispatch it.
 * - `unknown-type`: well-formed JSON whose `type` isn't one this CLI
 *   version knows — a NEWER server talking. Forward-compatible: ignore it
 *   (log once per type) instead of erroring. Pre-versioning CLIs treated
 *   this identically to corruption and silently dropped e.g. cancel
 *   frames whose enum had grown a value.
 * - `malformed`: a type we DO know failed schema parse (or the payload
 *   isn't JSON) — a real wire bug worth a loud log.
 */
export function classifyServerFrame(
  raw: string,
):
  | { kind: "ok"; msg: ServerToDeviceMessage }
  | { kind: "unknown-type"; type: string }
  | { kind: "malformed"; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "malformed", error: "not JSON" };
  }
  const type =
    typeof json === "object" && json !== null && "type" in json
      ? (json as { type: unknown }).type
      : undefined;
  if (typeof type === "string" && !SERVER_TO_DEVICE_TYPES.has(type)) {
    return { kind: "unknown-type", type };
  }
  const parsed = ServerToDeviceMessageSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "malformed", error: parsed.error.message };
  }
  return { kind: "ok", msg: parsed.data };
}

export interface WsClientOptions {
  url: string;
  token: string;
  onOpen?: () => void;
  onMessage: (msg: ServerToDeviceMessage) => void;
  onClose?: (code: number, reason: string) => void;
  /** Backoff caps. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const HEARTBEAT_MS = 30_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private backoff: number;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Unknown frame types already warned about (once per type, not per frame). */
  private warnedUnknownTypes = new Set<string>();

  constructor(private opts: WsClientOptions) {
    this.backoff = opts.initialBackoffMs ?? 1000;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }

  send(msg: DeviceToServerMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const parsed = DeviceToServerMessageSchema.parse(msg);
    this.ws.send(JSON.stringify(parsed));
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = this.opts.initialBackoffMs ?? 1000;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, HEARTBEAT_MS);
      this.opts.onOpen?.();
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      const frame = classifyServerFrame(raw.toString());
      if (frame.kind === "unknown-type") {
        if (!this.warnedUnknownTypes.has(frame.type)) {
          this.warnedUnknownTypes.add(frame.type);
          console.warn(
            `[ws] ignoring unknown frame type "${frame.type}" — the server is likely newer than this CLI; consider \`npm i -g opencara\``,
          );
        }
        return;
      }
      if (frame.kind === "malformed") {
        console.error("[ws] invalid frame:", frame.error);
        return;
      }
      this.opts.onMessage(frame.msg);
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf.toString();
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (code === WS_CLOSE_PROTOCOL_TOO_OLD) {
        // The server told us this protocol version is below its floor.
        // Reconnecting replays the exact same handshake, so it can never
        // succeed — stop instead of hammering the server forever.
        this.stopped = true;
      }
      this.opts.onClose?.(code, reason);
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error("[ws] error", err.message);
    });
  }

  private scheduleReconnect(): void {
    const max = this.opts.maxBackoffMs ?? 30_000;
    const jittered = Math.floor(this.backoff * (0.5 + Math.random()));
    setTimeout(() => this.connect(), jittered);
    this.backoff = Math.min(this.backoff * 2, max);
  }
}
