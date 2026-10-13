// How a turn's requests reach pi's model runtime: the abort signal a provider
// sees must stop with the response, not with pi-durable's settled generation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Models } from "@earendil-works/pi-ai";
import { withAgentAuth } from "../models.js";

/** A runtime whose single in-flight stream completes when the test says so. */
function runtime() {
  const seen: { signal?: AbortSignal; finish?: () => void } = {};
  const models = {
    streamSimple(_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) {
      const { promise, resolve } = Promise.withResolvers<void>();
      seen.signal = options?.signal;
      seen.finish = resolve;
      return { result: () => promise };
    },
  } as unknown as Models;
  return { models: withAgentAuth(models, {}, "p", undefined), seen };
}

const model = { provider: "p", baseUrl: "" } as never;

describe("withAgentAuth", () => {
  it("aborts a stream that is still coming in", () => {
    const { models, seen } = runtime();
    const request = new AbortController();
    models.streamSimple(model, {} as never, { signal: request.signal });
    request.abort("cancelled");
    assert.equal(seen.signal?.aborted, true);
    assert.equal(seen.signal?.reason, "cancelled");
  });

  it("keeps a finished stream's signal alive when the request's signal aborts later", async () => {
    const { models, seen } = runtime();
    const request = new AbortController();
    const stream = models.streamSimple(model, {} as never, { signal: request.signal });
    seen.finish?.();
    await stream.result();
    // pi-durable ends the generation's invocation here; a provider run that
    // the next request's tool results continue must survive it.
    request.abort("generation settled");
    assert.equal(seen.signal?.aborted, false);
  });
});
