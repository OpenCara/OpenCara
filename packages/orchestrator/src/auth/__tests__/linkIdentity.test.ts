import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideLinkAction,
  decideUnlinkAction,
  missingDisplayFields,
} from "../session.js";

/**
 * These target the pure decision functions rather than the DB wrappers.
 *
 * The orchestrator's suite runs with no external infra (see .github/workflows/
 * ci.yml), and a fake `db` cannot honestly stand in for drizzle here — its
 * `eq()` returns an opaque condition object, so a hand-rolled matcher silently
 * matches everything and the test passes for the wrong reason. Splitting the
 * decision out is what makes the security-relevant logic testable for real.
 */

describe("decideLinkAction", () => {
  it("inserts when the identity is not linked anywhere", () => {
    assert.deepEqual(decideLinkAction(undefined, "user-a"), { action: "insert" });
  });

  // THE security property. Re-pointing an identity at whoever linked it last
  // means controlling the external account grants whichever OpenCara account
  // linked it most recently.
  it("refuses when the identity belongs to a different account", () => {
    assert.deepEqual(
      decideLinkAction({ id: "i1", userId: "user-b" }, "user-a"),
      { action: "conflict" },
    );
  });

  it("refreshes, not duplicates, when re-linking to the same account", () => {
    assert.deepEqual(
      decideLinkAction({ id: "i1", userId: "user-a" }, "user-a"),
      { action: "refresh", identityId: "i1" },
    );
  });

  it("never returns insert for an identity that already exists", () => {
    for (const owner of ["user-a", "user-b"]) {
      const d = decideLinkAction({ id: "i1", userId: owner }, "user-a");
      assert.notEqual(d.action, "insert");
    }
  });
});

describe("decideUnlinkAction", () => {
  const github = { id: "i1", provider: "github" };
  const entra = { id: "i2", provider: "entra" };

  it("deletes the requested identity when another remains", () => {
    assert.deepEqual(decideUnlinkAction([github, entra], "entra"), {
      action: "delete",
      identityId: "i2",
    });
  });

  // An account with no identities can never be signed into again.
  it("refuses to remove the only identity", () => {
    assert.deepEqual(decideUnlinkAction([github], "github"), {
      action: "last_identity",
    });
  });

  it("reports not_linked for a provider the account doesn't have", () => {
    assert.deepEqual(decideUnlinkAction([github], "entra"), { action: "not_linked" });
  });

  it("checks not_linked before last_identity", () => {
    // A single unrelated identity must report not_linked, not last_identity —
    // otherwise the error tells the user to link another provider when the real
    // problem is that this one was never linked.
    assert.deepEqual(decideUnlinkAction([entra], "github"), { action: "not_linked" });
  });
});

describe("missingDisplayFields", () => {
  it("fills fields the account is missing", () => {
    assert.deepEqual(
      missingDisplayFields(
        { name: null, email: null },
        { name: "Ada", email: "ada@contoso.com" },
      ),
      { name: "Ada", email: "ada@contoso.com" },
    );
  });

  // Linking Microsoft must not rename a GitHub account.
  it("never overwrites fields the account already has", () => {
    assert.deepEqual(
      missingDisplayFields(
        { name: "Q", email: "q@x.io" },
        { name: "Ada", email: "ada@contoso.com" },
      ),
      {},
    );
  });

  it("fills each field independently", () => {
    assert.deepEqual(
      missingDisplayFields({ name: "Q", email: null }, { name: "Ada", email: "a@x.io" }),
      { email: "a@x.io" },
    );
  });

  it("copies nothing when the identity carries nothing", () => {
    assert.deepEqual(
      missingDisplayFields({ name: null, email: null }, { name: null, email: null }),
      {},
    );
  });

  it("copies nothing when the user row is absent", () => {
    assert.deepEqual(
      missingDisplayFields(undefined, { name: "Ada", email: "a@x.io" }),
      {},
    );
  });
});
