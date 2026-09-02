import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEventDedupeKey } from "../engine.js";
import type { PlatformEventInput } from "../engine.js";

function ev(type: string, payload: unknown, id = "guid-1"): PlatformEventInput {
  return { id, type, projectId: "project-1", payload };
}

describe("computeEventDedupeKey", () => {
  it("keys pull_request on number + action + head SHA", () => {
    const key = computeEventDedupeKey(
      ev("pull_request", {
        action: "synchronize",
        pull_request: { number: 144, head: { sha: "a0f0c450" } },
      }),
    );
    assert.equal(key, "pull_request:144:synchronize:a0f0c450");
  });

  it("collapses two re-delivered originals (distinct GUIDs, same push) onto one key", () => {
    // The exact #147 scenario: GitHub re-emits the same synchronize as a fresh
    // original with a new x-github-delivery GUID. Content is byte-identical.
    const payload = {
      action: "synchronize",
      pull_request: { number: 144, head: { sha: "a0f0c450" } },
    };
    const first = computeEventDedupeKey(ev("pull_request", payload, "86b7e7b0"));
    const second = computeEventDedupeKey(ev("pull_request", payload, "870ff2c0"));
    assert.equal(first, second);
    assert.notEqual(first, null);
  });

  it("gives a genuinely new push a different key (different head SHA)", () => {
    const before = computeEventDedupeKey(
      ev("pull_request", {
        action: "synchronize",
        pull_request: { number: 144, head: { sha: "aaaa1111" } },
      }),
    );
    const after = computeEventDedupeKey(
      ev("pull_request", {
        action: "synchronize",
        pull_request: { number: 144, head: { sha: "bbbb2222" } },
      }),
    );
    assert.notEqual(before, after);
  });

  it("distinguishes actions on the same head SHA (opened vs synchronize)", () => {
    const opened = computeEventDedupeKey(
      ev("pull_request", {
        action: "opened",
        pull_request: { number: 1, head: { sha: "deadbeef" } },
      }),
    );
    const synced = computeEventDedupeKey(
      ev("pull_request", {
        action: "synchronize",
        pull_request: { number: 1, head: { sha: "deadbeef" } },
      }),
    );
    assert.notEqual(opened, synced);
  });

  it("keys the opened action (one-shot per PR)", () => {
    assert.equal(
      computeEventDedupeKey(
        ev("pull_request", {
          action: "opened",
          pull_request: { number: 9, head: { sha: "cafef00d" } },
        }),
      ),
      "pull_request:9:opened:cafef00d",
    );
  });

  it("returns null for reopened — it can recur on an unchanged SHA", () => {
    // close→reopen with no intervening commit emits `reopened` twice with the
    // same head SHA; SHA-identity dedup would permanently drop the 2nd review.
    // Fall back to GUID-only by returning null. (issue #147 review.)
    assert.equal(
      computeEventDedupeKey(
        ev("pull_request", {
          action: "reopened",
          pull_request: { number: 9, head: { sha: "cafef00d" } },
        }),
      ),
      null,
    );
  });

  it("returns null for ready_for_review — draft↔ready can recur on one SHA", () => {
    assert.equal(
      computeEventDedupeKey(
        ev("pull_request", {
          action: "ready_for_review",
          pull_request: { number: 9, head: { sha: "cafef00d" } },
        }),
      ),
      null,
    );
  });

  it("returns null for a dedupable pull_request action without a head SHA", () => {
    assert.equal(
      computeEventDedupeKey(
        ev("pull_request", { action: "opened", pull_request: { number: 1 } }),
      ),
      null,
    );
  });

  it("keys pull_request_review on the stable review id", () => {
    const key = computeEventDedupeKey(
      ev("pull_request_review", {
        action: "submitted",
        review: { id: 987654 },
      }),
    );
    assert.equal(key, "pull_request_review:987654:submitted");
  });

  it("returns null for pull_request_review without a review id", () => {
    assert.equal(
      computeEventDedupeKey(
        ev("pull_request_review", { action: "submitted", review: {} }),
      ),
      null,
    );
  });

  it("keys issue_comment on the comment id + action", () => {
    const key = computeEventDedupeKey(
      ev("issue_comment", { action: "created", comment: { id: 42 } }),
    );
    assert.equal(key, "issue_comment:42:created");
  });

  it("scopes an Azure comment by its thread, since the id is a per-thread ordinal", () => {
    const key = computeEventDedupeKey(
      ev("issue_comment", { action: "created", comment: { id: 1, thread_id: 97 } }),
    );
    assert.equal(key, "issue_comment:97:1:created");
  });

  // THE BUG (2026-08-17): every thread's first comment is id 1, so the bare-id
  // key made the first one ever received claim `issue_comment:1:created` — and
  // the unique index behind it has no time bound, so every later `@opencara
  // review` was dropped before a flow run row was even created. Distinct
  // threads must produce distinct keys.
  it("does not collide two threads whose first comment is both id 1", () => {
    const first = computeEventDedupeKey(
      ev("issue_comment", { action: "created", comment: { id: 1, thread_id: 18 } }),
    );
    const second = computeEventDedupeKey(
      ev("issue_comment", { action: "created", comment: { id: 1, thread_id: 97 } }),
    );
    assert.notEqual(first, second);
    assert.notEqual(first, null);
    assert.notEqual(second, null);
  });

  it("still collapses a redelivery of the same Azure comment", () => {
    const payload = { action: "created", comment: { id: 2, thread_id: 90 } };
    assert.equal(
      computeEventDedupeKey(ev("issue_comment", payload, "delivery-a")),
      computeEventDedupeKey(ev("issue_comment", payload, "delivery-b")),
    );
  });

  // Fails OPEN. Over-deduping is unrecoverable here (a claimed key never
  // expires); an extra run is not.
  it("returns null for an Azure comment whose thread is unknown", () => {
    assert.equal(
      computeEventDedupeKey(
        ev("issue_comment", { action: "created", comment: { id: 1, thread_id: null } }),
      ),
      null,
    );
  });

  // GitHub ids are already globally unique — the scoped form must not leak
  // into their keys, or in-flight dedup would break across the deploy.
  it("leaves the GitHub key shape untouched", () => {
    assert.equal(
      computeEventDedupeKey(
        ev("issue_comment", {
          action: "created",
          comment: { id: 2894735820 },
          issue: { number: 147 },
        }),
      ),
      "issue_comment:2894735820:created",
    );
  });

  it("returns null for event types without a stable identity", () => {
    assert.equal(
      computeEventDedupeKey(
        ev("projects_v2_item", { action: "edited", projects_v2_item: { node_id: "x" } }),
      ),
      null,
    );
    assert.equal(computeEventDedupeKey(ev("issues", { action: "labeled" })), null);
  });

  it("returns null for a missing or non-object payload", () => {
    assert.equal(computeEventDedupeKey(ev("pull_request", null)), null);
    assert.equal(computeEventDedupeKey(ev("pull_request", "not-an-object")), null);
  });
});
