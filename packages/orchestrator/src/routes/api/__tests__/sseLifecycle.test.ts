import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SseLifecycle } from "../sseLifecycle.js";

describe("SseLifecycle", () => {
  it("cleans each resource once across repeated aborts", async () => {
    const lifecycle = new SseLifecycle();
    let calls = 0;
    lifecycle.add(() => { calls += 1; });
    await Promise.all([lifecycle.cleanup(), lifecycle.cleanup()]);
    assert.equal(calls, 1);
  });

  it("cleans a subscription that resolves after the stream aborted", async () => {
    const lifecycle = new SseLifecycle();
    await lifecycle.cleanup();
    let unlistened = false;
    lifecycle.add(async () => { unlistened = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unlistened, true);
  });
});
