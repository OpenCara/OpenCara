import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCron,
  nextCronOccurrences,
  nextCronOccurrence,
  isValidTimeZone,
} from "@opencara/shared";

const iso = (d: Date) => d.toISOString();

describe("validateCron", () => {
  it("accepts standard expressions", () => {
    for (const expr of [
      "* * * * *",
      "0 9 * * 1-5",
      "*/15 * * * *",
      "0 0 1 1 *",
      "30 8,12,18 * * *",
      "0 9 * * MON-FRI",
      "0 0 1 JAN *",
      "15 0-6/2 * * *",
    ]) {
      assert.equal(validateCron(expr).valid, true, `expected valid: ${expr}`);
    }
  });

  it("rejects malformed expressions with a reason", () => {
    for (const expr of [
      "", // empty
      "* * * *", // only 4 fields
      "* * * * * *", // 6 fields
      "60 * * * *", // minute out of range
      "* 24 * * *", // hour out of range
      "* * 0 * *", // day-of-month below 1
      "* * * 13 *", // month out of range
      "5-1 * * * *", // inverted range
      "*/0 * * * *", // zero step
      "abc * * * *", // non-numeric
    ]) {
      const r = validateCron(expr);
      assert.equal(r.valid, false, `expected invalid: "${expr}"`);
      assert.ok(r.error && r.error.length > 0, `expected an error message for "${expr}"`);
    }
  });

  it("normalises day-of-week 7 to Sunday (no error)", () => {
    assert.equal(validateCron("0 0 * * 7").valid, true);
  });
});

describe("nextCronOccurrences", () => {
  it("computes a simple daily schedule in UTC", () => {
    // 09:00 every day. From 2026-01-01T10:00Z the first fire is the 2nd.
    const from = new Date("2026-01-01T10:00:00Z");
    const out = nextCronOccurrences("0 9 * * *", from, 3, "UTC");
    assert.deepEqual(out.map(iso), [
      "2026-01-02T09:00:00.000Z",
      "2026-01-03T09:00:00.000Z",
      "2026-01-04T09:00:00.000Z",
    ]);
  });

  it("never returns the minute it is already in (strictly after `from`)", () => {
    const from = new Date("2026-01-01T09:00:00Z");
    const out = nextCronOccurrences("0 9 * * *", from, 1, "UTC");
    assert.equal(iso(out[0]!), "2026-01-02T09:00:00.000Z");
  });

  it("honours an every-15-minutes step", () => {
    const from = new Date("2026-01-01T00:02:00Z");
    const out = nextCronOccurrences("*/15 * * * *", from, 4, "UTC");
    assert.deepEqual(out.map(iso), [
      "2026-01-01T00:15:00.000Z",
      "2026-01-01T00:30:00.000Z",
      "2026-01-01T00:45:00.000Z",
      "2026-01-01T01:00:00.000Z",
    ]);
  });

  it("restricts to weekdays with a day-of-week range", () => {
    // Fri 2026-01-02 → next weekday fire skips Sat/Sun to Mon 2026-01-05.
    const from = new Date("2026-01-02T12:00:00Z");
    const out = nextCronOccurrences("0 9 * * 1-5", from, 2, "UTC");
    assert.deepEqual(out.map(iso), [
      "2026-01-05T09:00:00.000Z",
      "2026-01-06T09:00:00.000Z",
    ]);
  });

  it("applies the dom/dow union rule when both are restricted", () => {
    // Fire on the 15th OR any Monday. From 2026-01-01 (Thu) the first hits are
    // Mon Jan 5, Mon Jan 12, Thu Jan 15 (the 15th), Mon Jan 19...
    const from = new Date("2026-01-01T00:00:00Z");
    const out = nextCronOccurrences("0 0 15 * 1", from, 4, "UTC");
    assert.deepEqual(out.map(iso), [
      "2026-01-05T00:00:00.000Z",
      "2026-01-12T00:00:00.000Z",
      "2026-01-15T00:00:00.000Z",
      "2026-01-19T00:00:00.000Z",
    ]);
  });

  it("evaluates wall-clock time in a named timezone (DST-aware)", () => {
    // 09:00 America/New_York. In January NY is UTC-5, so 09:00 local = 14:00Z.
    const from = new Date("2026-01-01T00:00:00Z");
    const out = nextCronOccurrences("0 9 * * *", from, 1, "America/New_York");
    assert.equal(iso(out[0]!), "2026-01-01T14:00:00.000Z");
  });

  it("returns an empty list for an impossible date", () => {
    // Feb 30 never occurs.
    const from = new Date("2026-01-01T00:00:00Z");
    const out = nextCronOccurrences("0 0 30 2 *", from, 1, "UTC");
    assert.deepEqual(out, []);
  });

  it("returns [] for count <= 0", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    assert.deepEqual(nextCronOccurrences("* * * * *", from, 0, "UTC"), []);
  });
});

describe("nextCronOccurrence", () => {
  it("returns the single next fire time", () => {
    const from = new Date("2026-03-10T08:00:00Z");
    const next = nextCronOccurrence("0 9 * * *", from, "UTC");
    assert.equal(iso(next!), "2026-03-10T09:00:00.000Z");
  });

  it("returns null when none exist within a year", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    assert.equal(nextCronOccurrence("0 0 31 2 *", from, "UTC"), null);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones and UTC", () => {
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("America/New_York"), true);
    assert.equal(isValidTimeZone("Europe/London"), true);
  });
  it("rejects nonsense zones", () => {
    assert.equal(isValidTimeZone("Not/AZone"), false);
    assert.equal(isValidTimeZone(""), false);
  });
});
