import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInstructionsFile } from "../instructionsFile.js";

describe("resolveInstructionsFile", () => {
  let dir: string;
  let skipped: string[];
  const resolve = (cwd: string, relative: string | undefined) =>
    resolveInstructionsFile(cwd, relative, (_stream, chunk) => skipped.push(chunk));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opencara-instructions-"));
    skipped = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a file inside cwd, nested paths and in-tree symlinks included", () => {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "agents.md"), "shared rules\n");
    symlinkSync(join(dir, "docs", "agents.md"), join(dir, "AGENTS.md"));
    assert.equal(resolve(dir, "docs/agents.md")?.content, "shared rules\n");
    assert.equal(resolve(dir, "AGENTS.md")?.content, "shared rules\n");
  });

  it("is a silent no-op when no file is configured", () => {
    assert.equal(resolve(dir, undefined), null);
    assert.deepEqual(skipped, []);
  });

  it("skips, with a reason, paths that leave cwd or are not readable files", () => {
    const outside = mkdtempSync(join(tmpdir(), "opencara-secret-"));
    try {
      writeFileSync(join(outside, "secret.md"), "TOP SECRET\n");
      // A committed symlink pointing at a secret outside the worktree.
      symlinkSync(join(outside, "secret.md"), join(dir, "AGENTS.md"));
      mkdirSync(join(dir, "dir.md"));
      writeFileSync(join(dir, "big.md"), "x".repeat(65 * 1024));
      for (const [cwd, relative] of [
        [dir, "AGENTS.md"],
        [dir, "/etc/passwd"],
        [dir, "../escape.md"],
        [dir, "a/../../escape.md"],
        [dir, "missing.md"],
        [dir, "dir.md"],
        [dir, "big.md"],
        ["relative/cwd", "AGENTS.md"],
      ] as const) {
        assert.equal(resolve(cwd, relative), null, `${cwd} + ${relative}`);
      }
      assert.equal(skipped.length, 8);
      assert.ok(skipped.every((line) => line.startsWith("[opencara] instructions file skipped:")));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
