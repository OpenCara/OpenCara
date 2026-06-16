// WsClient reconnect-backoff behavior against a real `ws` server.
//
// Regression guard for the 1006 reconnect-storm: the client used to reset its
// backoff to the floor on every `open`, so a socket that died ~1s after
// connecting looped at the 1s floor forever (thousands of reconnects). The fix
// only resets backoff once a socket has stayed open past `stableMs`. These
// tests assert:
//   1. Sockets that die before `stableMs` → backoff ESCALATES (no floor loop).
//   2. A socket that lives past `stableMs` → backoff RESETS to the floor.
//
// We stand up a real WebSocketServer and drive close timing from the server
// side; assertions use generous margins so jitter (0.5–1.5×) can't flake them.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { WsClient } from "../ws-client.js";

async function listen(): Promise<{ wss: WebSocketServer; url: string }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const addr = wss.address();
  if (typeof addr === "string" || addr === null) throw new Error("no port");
  return { wss, url: `ws://127.0.0.1:${addr.port}` };
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("WsClient reconnect backoff", () => {
  it("escalates backoff when sockets die before stableMs", async () => {
    const { wss, url } = await listen();
    const arrivals: number[] = [];
    wss.on("connection", (sock: WsSocket) => {
      arrivals.push(Date.now());
      sock.close(); // dies immediately — never reaches stableMs
    });

    const client = new WsClient({
      url,
      token: "x",
      onMessage: () => {},
      initialBackoffMs: 50,
      maxBackoffMs: 5000,
      stableMs: 60_000, // huge: no connection ever counts as stable
    });
    client.start();

    try {
      await waitFor(() => arrivals.length >= 6);
      const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
      // gaps[0] base≈50 (≤~75ms); gaps[4] base≈800 (≥~400ms). If the backoff
      // had wrongly reset on every open, every gap would hug the ~50ms floor.
      assert.ok(
        gaps[4]! > gaps[0]!,
        `expected escalation: late gap ${gaps[4]}ms should exceed early gap ${gaps[0]}ms`,
      );
      assert.ok(gaps[4]! > 250, `expected late gap to climb off the floor, got ${gaps[4]}ms`);
    } finally {
      client.stop();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });

  it("resets backoff to the floor once a socket stays open past stableMs", async () => {
    const stableMs = 120;
    const STABLE_IDX = 5; // grow backoff over 5 fast-die cycles first
    const { wss, url } = await listen();
    const arrivals: number[] = [];
    let stableClosedAt = 0;
    let idx = -1;
    wss.on("connection", (sock: WsSocket) => {
      const myIdx = ++idx;
      arrivals.push(Date.now());
      if (myIdx === STABLE_IDX) {
        // Hold open past stableMs so the client marks it stable + resets, then
        // close to trigger one more reconnect.
        setTimeout(() => {
          stableClosedAt = Date.now();
          sock.close();
        }, stableMs + 100);
      } else {
        sock.close();
      }
    });

    const client = new WsClient({
      url,
      token: "x",
      onMessage: () => {},
      initialBackoffMs: 50,
      maxBackoffMs: 5000,
      stableMs,
    });
    client.start();

    try {
      await waitFor(() => arrivals.length >= STABLE_IDX + 2);
      // Reconnect delay INTO the stable connection: backoff has escalated.
      const preGap = arrivals[STABLE_IDX]! - arrivals[STABLE_IDX - 1]!;
      // Reconnect delay AFTER the stable close: measured from the close, so the
      // hold time is excluded — should be back at the ~50ms floor.
      const postGap = arrivals[STABLE_IDX + 1]! - stableClosedAt;
      assert.ok(preGap > 250, `expected escalated pre-stable gap, got ${preGap}ms`);
      assert.ok(postGap < 150, `expected reset post-stable gap near floor, got ${postGap}ms`);
      assert.ok(
        postGap * 3 < preGap,
        `expected reset (post ${postGap}ms) well below escalated (pre ${preGap}ms)`,
      );
    } finally {
      client.stop();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
