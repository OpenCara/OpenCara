import WebSocket from "ws";
import {
  DeviceToServerMessageSchema,
  ServerToDeviceMessageSchema,
  type DeviceToServerMessage,
  type ServerToDeviceMessage,
} from "@opencara/shared";

export interface WsClientOptions {
  url: string;
  token: string;
  onOpen?: () => void;
  onMessage: (msg: ServerToDeviceMessage) => void;
  onClose?: (code: number, reason: string) => void;
  /** Backoff caps. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * How long a socket must stay open before it's deemed "stable" and the
   * reconnect backoff is reset to its initial value. A socket that dies sooner
   * keeps escalating the backoff instead of looping at the floor. See connect().
   */
  stableMs?: number;
}

const HEARTBEAT_MS = 30_000;
const STABLE_MS = 10_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private backoff: number;
  private heartbeat: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private opts: WsClientOptions) {
    this.backoff = opts.initialBackoffMs ?? 1000;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.stableTimer) clearTimeout(this.stableTimer);
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
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, HEARTBEAT_MS);
      // Reset backoff only once the connection has PROVEN stable (stayed open
      // past stableMs) — not on `open`. Otherwise a socket that dies ~1s after
      // connecting (e.g. a Cloudflare-recycled path, or two clients sharing a
      // token mutually superseding each other) resets the backoff every cycle
      // and the client loops at the 1s floor forever, amplifying one drop into
      // a reconnect storm. Letting the backoff escalate turns that storm into a
      // gentle 30s retry instead.
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.backoff = this.opts.initialBackoffMs ?? 1000;
        this.stableTimer = null;
      }, this.opts.stableMs ?? STABLE_MS);
      this.opts.onOpen?.();
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      let parsed: ServerToDeviceMessage;
      try {
        parsed = ServerToDeviceMessageSchema.parse(JSON.parse(raw.toString()));
      } catch (err) {
        console.error("[ws] invalid frame", err);
        return;
      }
      this.opts.onMessage(parsed);
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf.toString();
      if (this.heartbeat) clearInterval(this.heartbeat);
      // Cancel the pending stability reset — this socket never reached stable,
      // so its backoff must carry over (and keep growing) into the next attempt.
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
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
