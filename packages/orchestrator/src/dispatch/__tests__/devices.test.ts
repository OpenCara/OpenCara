import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { DevicePool, type ConnectedDevice } from "../devices.js";

/**
 * register() voids a DB write (`db.update(...).set(...).where(...)`); a
 * chainable no-op stand-in keeps the pool happy without a real connection.
 */
function fakeDb(): any {
  const chain = { set: () => chain, where: () => Promise.resolve() };
  return { update: () => chain };
}

interface FakeRaw {
  readyState: number;
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): void;
  pings: number;
  terminates: number;
  firePong(): void;
}

function fakeRaw(): FakeRaw {
  let pongListener: (() => void) | null = null;
  return {
    readyState: 1,
    pings: 0,
    terminates: 0,
    ping() {
      this.pings++;
    },
    terminate() {
      this.terminates++;
    },
    on(_event, listener) {
      pongListener = listener;
    },
    firePong() {
      pongListener?.();
    },
  };
}

interface FakeWs {
  raw: FakeRaw;
  closes: Array<{ code?: number; reason?: string }>;
  close(code?: number, reason?: string): void;
}

function fakeWs(): FakeWs {
  return {
    raw: fakeRaw(),
    closes: [],
    close(code, reason) {
      this.closes.push({ code, reason });
    },
  };
}

function makeDevice(hostId: string, connId: string, ws: FakeWs): ConnectedDevice {
  return {
    agentHostId: hostId,
    connId,
    userId: null,
    isAlive: true,
    ws: ws as never,
    inflight: new Set<string>(),
  };
}

describe("DevicePool connection-identity race", () => {
  it("supersedes an existing socket on re-register and keeps the new one", () => {
    const pool = new DevicePool(fakeDb());
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    pool.register(makeDevice("host", "connA", ws1));
    pool.register(makeDevice("host", "connB", ws2));

    // Old socket was proactively closed as "superseded".
    assert.deepEqual(ws1.closes, [{ code: 4000, reason: "superseded" }]);
    assert.equal(ws2.closes.length, 0);
    // The live registration is the new connection.
    assert.equal(pool.byId("host")?.connId, "connB");
    assert.equal(pool.isConnected("host"), true);
  });

  it("ignores a stale socket's late close after the device reconnected", () => {
    const pool = new DevicePool(fakeDb());
    pool.register(makeDevice("host", "connA", fakeWs()));
    pool.register(makeDevice("host", "connB", fakeWs()));

    // connA's onClose finally fires AFTER connB took over — must not evict it.
    pool.unregister("host", "connA");

    assert.equal(pool.isConnected("host"), true);
    assert.equal(pool.byId("host")?.connId, "connB");
  });

  it("a live close (matching connId) does evict the device", () => {
    const pool = new DevicePool(fakeDb());
    pool.register(makeDevice("host", "connA", fakeWs()));

    pool.unregister("host", "connA");

    assert.equal(pool.isConnected("host"), false);
    assert.equal(pool.byId("host"), null);
  });

  it("a stale close does not reject jobs dispatched to the live socket", async () => {
    const pool = new DevicePool(fakeDb());
    pool.register(makeDevice("host", "connA", fakeWs()));
    pool.register(makeDevice("host", "connB", fakeWs()));

    let settled = false;
    const job = pool
      .awaitJob("run-1", "host", "connB", () => {}, null, null, null)
      .then(() => (settled = true))
      .catch(() => (settled = true));

    // Stale connA close — connB's job must stay pending.
    pool.unregister("host", "connA");
    await delay(0);
    assert.equal(settled, false);

    // Live connB close — now it rejects.
    pool.unregister("host", "connB");
    await job;
    assert.equal(settled, true);
  });

  it("rejects only the closing connection's jobs", async () => {
    const pool = new DevicePool(fakeDb());
    pool.register(makeDevice("host", "connA", fakeWs()));

    let aRejected = false;
    const jobA = pool
      .awaitJob("run-A", "host", "connA", () => {}, null, null, null)
      .catch(() => (aRejected = true));

    pool.unregister("host", "connA");
    await jobA;
    assert.equal(aRejected, true);
  });
});

describe("DevicePool heartbeat sweep", () => {
  it("pings live sockets and arms them for the next round", () => {
    const pool = new DevicePool(fakeDb());
    const ws = fakeWs();
    pool.register(makeDevice("host", "connA", ws));

    pool.heartbeatSweep();

    assert.equal(ws.raw.pings, 1);
    // isAlive was flipped false; a pong re-arms it.
    assert.equal(pool.byId("host")?.isAlive, false);
    ws.raw.firePong();
    assert.equal(pool.byId("host")?.isAlive, true);
  });

  it("terminates a socket that missed the previous round's pong", () => {
    const pool = new DevicePool(fakeDb());
    const ws = fakeWs();
    pool.register(makeDevice("host", "connA", ws));

    // First sweep arms (isAlive -> false); no pong arrives; second sweep reaps.
    pool.heartbeatSweep();
    pool.heartbeatSweep();

    assert.equal(ws.raw.terminates, 1);
    // ping only happened on the first (live) round, not the reaping round.
    assert.equal(ws.raw.pings, 1);
  });
});
