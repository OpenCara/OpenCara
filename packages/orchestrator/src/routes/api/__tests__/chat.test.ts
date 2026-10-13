import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeImages } from "../chat.js";

describe("normalizeImages", () => {
  it("keeps well-formed image attachments and lowercases the mime type", () => {
    const out = normalizeImages([
      { data: "AAAA", mimeType: "image/PNG" },
      { data: "BBBB", mimeType: "image/jpeg" },
    ]);
    assert.deepEqual(out, [
      { data: "AAAA", mimeType: "image/png" },
      { data: "BBBB", mimeType: "image/jpeg" },
    ]);
  });

  it("drops non-array, malformed, empty, and non-image entries", () => {
    assert.deepEqual(normalizeImages(undefined), []);
    assert.deepEqual(normalizeImages("nope"), []);
    assert.deepEqual(
      normalizeImages([
        null,
        42,
        { data: "", mimeType: "image/png" }, // empty payload
        { data: "X", mimeType: "application/pdf" }, // wrong type
        { data: "X" }, // missing mime
        { mimeType: "image/png" }, // missing data
      ]),
      [],
    );
  });

  it("caps the attachment count at the per-turn limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      data: `d${i}`,
      mimeType: "image/png",
    }));
    assert.equal(normalizeImages(many).length, 8);
  });

  it("rejects oversized base64 payloads", () => {
    const huge = "a".repeat(10_000_001);
    assert.deepEqual(normalizeImages([{ data: huge, mimeType: "image/png" }]), []);
  });

  it("stops once the aggregate base64 budget is exceeded", () => {
    // Three 9M-char images = 27M > the 24M aggregate cap, so only the
    // first two (18M) survive even though the per-image and count caps
    // would each allow all three.
    const nineM = "a".repeat(9_000_000);
    const out = normalizeImages([
      { data: nineM, mimeType: "image/png" },
      { data: nineM, mimeType: "image/png" },
      { data: nineM, mimeType: "image/png" },
    ]);
    assert.equal(out.length, 2);
  });
});
