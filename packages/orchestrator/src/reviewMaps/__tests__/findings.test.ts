import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFindings } from "../findings.js";

const FILES = [
  { path: "src/api/handler.ts" },
  { path: "src/api/router.ts" },
  { path: "src/db/store.py" },
  { path: "lib/util/util.go" },
];

describe("extractFindings", () => {
  it("attaches a full-path mention with a line number", () => {
    const md = "- `src/api/handler.ts:42` dereferences a nil pointer";
    const out = extractFindings(md, FILES);
    const findings = out.get("src/api/handler.ts")!;
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.line, 42);
    assert.equal(findings[0]!.severity, "info");
    assert.equal(
      findings[0]!.text,
      "src/api/handler.ts:42 dereferences a nil pointer",
    );
  });

  it("reads ranges in :N-M and #LN-LM forms", () => {
    const md = "src/db/store.py:10-25 is unbatched\nsrc/api/router.ts#L3-L7 dup";
    const out = extractFindings(md, FILES);
    assert.deepEqual(
      out.get("src/db/store.py")!.map((f) => [f.line, f.endLine]),
      [[10, 25]],
    );
    assert.deepEqual(
      out.get("src/api/router.ts")!.map((f) => [f.line, f.endLine]),
      [[3, 7]],
    );
  });

  it("matches a unique basename but not an ambiguous one", () => {
    const md = "- store.py drops the transaction\n- handler.ts is fine\n";
    const out = extractFindings(md, [
      { path: "a/store.py" },
      { path: "b/handler.ts" },
      { path: "c/handler.ts" },
    ]);
    assert.equal(out.get("a/store.py")!.length, 1);
    assert.equal(out.has("b/handler.ts"), false);
    assert.equal(out.has("c/handler.ts"), false);
  });

  it("does not match a basename inside a longer path", () => {
    const md = "- other/store.py is unchanged upstream";
    const out = extractFindings(md, [{ path: "pkg/store.py" }]);
    assert.equal(out.has("pkg/store.py"), false);
  });

  it("takes severity from the line, falling back to the heading", () => {
    const md = [
      "## Critical issues",
      "- src/api/handler.ts crashes on empty input",
      "",
      "## Nits",
      "- src/api/router.ts:1 could be shorter",
      "- blocker: src/db/store.py races on reconnect",
    ].join("\n");
    const out = extractFindings(md, FILES);
    assert.equal(out.get("src/api/handler.ts")![0]!.severity, "high");
    assert.equal(out.get("src/api/router.ts")![0]!.severity, "low");
    // The line's own severity word wins over the section heading.
    assert.equal(out.get("src/db/store.py")![0]!.severity, "high");
  });

  it("dedupes identical finding text per file", () => {
    const md = [
      "- src/api/handler.ts is risky",
      "- src/api/handler.ts is risky",
      "- src/api/handler.ts is risky again",
    ].join("\n");
    const out = extractFindings(md, FILES);
    assert.equal(out.get("src/api/handler.ts")!.length, 2);
  });

  it("returns an empty map when nothing matches", () => {
    const out = extractFindings("Looks good overall.", FILES);
    assert.equal(out.size, 0);
  });

  it("does not read 'high-level'/'low-level' as severity", () => {
    const md = "- src/api/handler.ts is a high-level concern of this PR";
    const out = extractFindings(md, FILES);
    assert.equal(out.get("src/api/handler.ts")![0]!.severity, "info");
  });

  it("skips file mentions under a summary-style heading", () => {
    const md = [
      "## Summary",
      "- src/api/handler.ts now routes retries through the pool",
      "- src/db/store.py gained a batch insert",
      "",
      "## Findings",
      "- blocker: src/db/store.py:9 drops the transaction",
    ].join("\n");
    const out = extractFindings(md, FILES);
    assert.equal(out.has("src/api/handler.ts"), false);
    // The store.py mention under Findings still lands; the Summary one doesn't.
    assert.equal(out.get("src/db/store.py")!.length, 1);
    assert.equal(out.get("src/db/store.py")![0]!.severity, "high");
  });
});
