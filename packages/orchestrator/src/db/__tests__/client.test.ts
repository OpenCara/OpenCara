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
    assert.deepEqual(o.connection, {
      statement_timeout: 30_000,
      application_name: "opencara-server",
    });
  });

  it("disables ssl only for loopback hosts", () => {
    assert.equal(poolOptions(LOCAL, {}).ssl, false);
    assert.equal(poolOptions(REMOTE, {}).ssl, "require");
  });

  it("disables ssl for dotless service names and private IPs", () => {
    // The prod local-PG topology (OpenCara#245): `db` is a compose-network
    // name that never leaves the host bridge.
    assert.equal(
      poolOptions("postgres://opencara:pw@db:5432/opencara", {}).ssl,
      false,
    );
    assert.equal(
      poolOptions("postgres://u:p@192.168.4.10:5432/x", {}).ssl,
      false,
    );
    assert.equal(
      poolOptions("postgres://u:p@10.2.3.4:5432/x", {}).ssl,
      false,
    );
    // A dotted LAN name still defaults to require — it could route off-box.
    assert.equal(
      poolOptions("postgres://u:p@pg.internal.lan:5432/x", {}).ssl,
      "require",
    );
  });

  it("DB_SSL overrides the hostname guess both ways", () => {
    assert.equal(poolOptions("postgres://u:p@db:5432/x", { DB_SSL: "require" }).ssl, "require");
    assert.equal(poolOptions(REMOTE, { DB_SSL: "disable" }).ssl, false);
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
    assert.deepEqual(o.connection, {
      statement_timeout: 5000,
      application_name: "opencara-server",
    });
  });

  it("ignores non-positive / non-numeric overrides and keeps defaults", () => {
    const o = poolOptions(REMOTE, { DB_POOL_MAX: "0", DB_STATEMENT_TIMEOUT_MS: "abc" });
    assert.equal(o.max, 12);
    assert.deepEqual(o.connection, {
      statement_timeout: 30_000,
      application_name: "opencara-server",
    });
  });
});
