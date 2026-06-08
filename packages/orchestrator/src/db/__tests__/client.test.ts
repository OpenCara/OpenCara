// Unit tests for the postgres-js pool tuning (OpenCara#146). poolOptions is
// pure (env in, options out) so the defenses — bounded pool, statement timeout,
// connection recycling — can be asserted without opening a connection.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { poolOptions } from "../client.js";

const REMOTE = "postgres://u:p@db.example.com:5432/postgres";
const LOCAL = "postgres://opencara:opencara@localhost:5433/opencara";

describe("poolOptions", () => {
  it("applies hardened defaults on a remote URL", () => {
    const o = poolOptions(REMOTE, {});
    assert.equal(o.max, 12);
    assert.equal(o.ssl, "require");
    assert.equal(o.connect_timeout, 10);
    assert.equal(o.max_lifetime, 60 * 30);
    assert.equal(o.idle_timeout, 60);
    assert.deepEqual(o.connection, { statement_timeout: 30_000 });
  });

  it("disables ssl only for loopback hosts", () => {
    assert.equal(poolOptions(LOCAL, {}).ssl, false);
    assert.equal(poolOptions(REMOTE, {}).ssl, "require");
  });

  it("honours env overrides", () => {
    const o = poolOptions(REMOTE, {
      DB_POOL_MAX: "40",
      DB_CONNECT_TIMEOUT_SEC: "5",
      DB_MAX_LIFETIME_SEC: "120",
      DB_IDLE_TIMEOUT_SEC: "30",
      DB_STATEMENT_TIMEOUT_MS: "5000",
    });
    assert.equal(o.max, 40);
    assert.equal(o.connect_timeout, 5);
    assert.equal(o.max_lifetime, 120);
    assert.equal(o.idle_timeout, 30);
    assert.deepEqual(o.connection, { statement_timeout: 5000 });
  });

  it("ignores non-positive / non-numeric overrides and keeps defaults", () => {
    const o = poolOptions(REMOTE, { DB_POOL_MAX: "0", DB_STATEMENT_TIMEOUT_MS: "abc" });
    assert.equal(o.max, 12);
    assert.deepEqual(o.connection, { statement_timeout: 30_000 });
  });
});
