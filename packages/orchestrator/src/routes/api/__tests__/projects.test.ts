// Tests for the project PATCH route's `instructionsFile` validation
// helper. Route wiring itself is exercised by manual smokes — this
// pins down the input rules surfaced as 400 errors so they stay in
// sync with the dispatch-time validator (validateInstructionsFileSetting).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateInstructionsFileInput } from "../projects.js";

describe("validateInstructionsFileInput", () => {
  it("accepts a repo-relative .md path", () => {
    const r = validateInstructionsFileInput("AGENTS.md");
    assert.equal(r.value, "AGENTS.md");
    assert.equal(r.error, undefined);
  });

  it("accepts a nested .md path", () => {
    const r = validateInstructionsFileInput(".opencara/instructions.md");
    assert.equal(r.value, ".opencara/instructions.md");
  });

  it("accepts uppercase .MD extension", () => {
    const r = validateInstructionsFileInput("AGENTS.MD");
    assert.equal(r.value, "AGENTS.MD");
  });

  it("trims surrounding whitespace before validating", () => {
    const r = validateInstructionsFileInput("  AGENTS.md  ");
    assert.equal(r.value, "AGENTS.md");
  });

  it("accepts an empty string (disables injection)", () => {
    const r = validateInstructionsFileInput("");
    assert.equal(r.value, "");
  });

  it("accepts whitespace-only as empty", () => {
    const r = validateInstructionsFileInput("\t  \n");
    assert.equal(r.value, "");
  });

  it("rejects non-string input", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      const r = validateInstructionsFileInput(bad);
      assert.equal(r.value, undefined, `should reject ${JSON.stringify(bad)}`);
      assert.match(r.error ?? "", /must be a string/);
    }
  });

  it("rejects POSIX absolute paths", () => {
    const r = validateInstructionsFileInput("/etc/passwd.md");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /repo-relative, not absolute/);
  });

  it("rejects Windows-drive absolute paths", () => {
    for (const bad of ["C:\\secrets.md", "D:/x.md"]) {
      const r = validateInstructionsFileInput(bad);
      assert.equal(r.value, undefined, `should reject ${bad}`);
      assert.match(r.error ?? "", /repo-relative, not absolute/);
    }
  });

  it("rejects paths with '..' segments", () => {
    for (const bad of [
      "..",
      "../parent.md",
      "foo/../bar.md",
      "a\\..\\b.md",
    ]) {
      const r = validateInstructionsFileInput(bad);
      assert.equal(r.value, undefined, `should reject ${bad}`);
      assert.match(r.error ?? "", /'\.\.' segments/);
    }
  });

  it("rejects extensions other than .md", () => {
    for (const bad of [
      "AGENTS",
      "AGENTS.txt",
      "instructions.markdown",
      "secret.env",
    ]) {
      const r = validateInstructionsFileInput(bad);
      assert.equal(r.value, undefined, `should reject ${bad}`);
      assert.match(r.error ?? "", /must end in \.md/);
    }
  });
});
