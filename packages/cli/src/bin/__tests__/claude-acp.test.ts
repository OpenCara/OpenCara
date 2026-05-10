// Unit tests for the pure handlers inside claude-acp. The real CLI
// surface (stdin loop + spawn of `claude`) is exercised by integration
// smokes; here we only cover the in-process state and protocol shapes.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  handleInitialize,
  handleLoadSession,
  handleNewSession,
  sessions,
} from "../claude-acp.js";

beforeEach(() => sessions.clear());

describe("handleInitialize", () => {
  it("advertises loadSession: true so callers know resume is supported", () => {
    const r = handleInitialize({ protocolVersion: 1 }) as {
      agentCapabilities: { loadSession: boolean };
    };
    assert.equal(r.agentCapabilities.loadSession, true);
  });
});

describe("handleNewSession", () => {
  it("registers a session keyed by the returned sessionId", () => {
    const r = handleNewSession({ cwd: "/tmp" }) as { sessionId: string };
    assert.match(r.sessionId, /^[0-9a-f-]{36}$/);
    assert.ok(sessions.has(r.sessionId));
    assert.equal(sessions.get(r.sessionId)?.cwd, "/tmp");
  });

  it("falls back to process.cwd() when cwd missing", () => {
    const r = handleNewSession({} as { cwd: string }) as { sessionId: string };
    assert.equal(sessions.get(r.sessionId)?.cwd, process.cwd());
  });
});

describe("handleLoadSession", () => {
  it("registers the supplied id (the orchestrator-persisted one) and returns empty", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const r = handleLoadSession({ sessionId: id, cwd: "/wt/branch" });
    assert.deepEqual(r, {});
    assert.ok(sessions.has(id));
    assert.equal(sessions.get(id)?.cwd, "/wt/branch");
  });

  it("rejects an empty sessionId so callers fail loud, not silently", () => {
    assert.throws(
      () => handleLoadSession({ sessionId: "", cwd: "/x" }),
      /session\/load: sessionId required/,
    );
  });

  it("falls back to process.cwd() when cwd missing", () => {
    const id = "deadbeef-dead-beef-dead-beefdeadbeef";
    handleLoadSession({ sessionId: id } as { sessionId: string; cwd: string });
    assert.equal(sessions.get(id)?.cwd, process.cwd());
  });

  it("idempotent — repeated load with the same id is a no-op overwrite", () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    handleLoadSession({ sessionId: id, cwd: "/first" });
    handleLoadSession({ sessionId: id, cwd: "/second" });
    assert.equal(sessions.size, 1);
    assert.equal(sessions.get(id)?.cwd, "/second");
  });
});
