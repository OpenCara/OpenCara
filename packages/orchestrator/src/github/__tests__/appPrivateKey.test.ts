// Boot-time GitHub App key validation (config.ts). Regression coverage for
// the 2026-07-06 incident: a PEM inlined into .env.production lost its
// newlines, every App-authenticated call failed with a swallowed
// ERR_OSSL_UNSUPPORTED, and /health stayed green throughout.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { validateAppPrivateKeyPem } from "../../config.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("validateAppPrivateKeyPem", () => {
  it("returns a well-formed PEM unchanged", () => {
    assert.equal(validateAppPrivateKeyPem(privateKey), privateKey);
  });

  it("accepts a PEM round-tripped through \\n-escaped env encoding", () => {
    const escaped = privateKey.replace(/\n/g, "\\n");
    const decoded = escaped.replace(/\\n/g, "\n");
    assert.equal(validateAppPrivateKeyPem(decoded), decoded);
  });

  it("rejects a PEM whose newlines were eaten (the incident shape)", () => {
    const glued = privateKey.replace(/\n/g, "");
    assert.throws(
      () => validateAppPrivateKeyPem(glued),
      /does not parse as a private key.*\\n sequences/s,
    );
  });

  it("rejects garbage", () => {
    assert.throws(() => validateAppPrivateKeyPem("not a key"), /does not parse/);
  });
});
