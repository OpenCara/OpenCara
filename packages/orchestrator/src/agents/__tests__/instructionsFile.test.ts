import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateInstructionsFileSetting } from "../instructionsFile.js";

describe("validateInstructionsFileSetting", () => {
  it("accepts a plain repo-relative path", () => {
    const r = validateInstructionsFileSetting({ setting: "AGENTS.md" });
    assert.equal(r.relativePath, "AGENTS.md");
    assert.equal(r.skipReason, undefined);
  });

  it("accepts a nested repo-relative path", () => {
    const r = validateInstructionsFileSetting({
      setting: ".opencara/instructions.md",
    });
    assert.equal(r.relativePath, ".opencara/instructions.md");
  });

  it("trims surrounding whitespace before validating", () => {
    const r = validateInstructionsFileSetting({ setting: "  AGENTS.md  " });
    assert.equal(r.relativePath, "AGENTS.md");
  });

  it("treats empty / whitespace-only settings as 'disabled'", () => {
    for (const setting of ["", "   ", "\t\n"]) {
      const r = validateInstructionsFileSetting({ setting });
      assert.equal(r.relativePath, undefined, `failed for ${JSON.stringify(setting)}`);
      assert.match(r.skipReason ?? "", /empty/);
    }
  });

  it("treats null / undefined / non-string as 'disabled'", () => {
    for (const setting of [null, undefined, 42 as unknown as string, {} as unknown as string]) {
      const r = validateInstructionsFileSetting({ setting });
      assert.equal(r.relativePath, undefined);
      assert.match(r.skipReason ?? "", /empty/);
    }
  });

  it("rejects POSIX absolute paths", () => {
    const r = validateInstructionsFileSetting({ setting: "/etc/passwd" });
    assert.equal(r.relativePath, undefined);
    assert.match(r.skipReason ?? "", /repo-relative, not absolute/);
  });

  it("rejects Windows-drive absolute paths", () => {
    for (const bad of ["C:\\secret.md", "D:/x.md"]) {
      const r = validateInstructionsFileSetting({ setting: bad });
      assert.equal(r.relativePath, undefined, `failed for ${bad}`);
      assert.match(r.skipReason ?? "", /repo-relative, not absolute/);
    }
  });

  it("rejects paths containing '..' as a path segment", () => {
    for (const bad of [
      "..",
      "../foo.md",
      "foo/../bar.md",
      "a/../../b.md",
      "a\\..\\b.md",
    ]) {
      const r = validateInstructionsFileSetting({ setting: bad });
      assert.equal(r.relativePath, undefined, `should reject ${bad}`);
      assert.match(r.skipReason ?? "", /'\.\.' segment/);
    }
  });

  it("permits names with a '..' substring (only segments count)", () => {
    // `foo..bar.md` is one segment; the '..' is part of the filename, not
    // a parent-directory traversal. We allow this — the rejection is about
    // path navigation, not pattern matching.
    const r = validateInstructionsFileSetting({ setting: "foo..bar.md" });
    assert.equal(r.relativePath, "foo..bar.md");
  });
});
