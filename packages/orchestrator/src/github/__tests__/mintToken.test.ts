import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableMintError,
  mintEphemeralTokenWithRetry,
  MINT_RETRY_DELAYS_MS,
} from "../app.js";
import type { EphemeralToken, GithubAppClient } from "../app.js";

const TOKEN: EphemeralToken = { token: "ghs_x", expiresAt: "2026-01-01T00:00:00Z" };

function fakeGithub(impl: () => Promise<EphemeralToken>): GithubAppClient {
  return { mintEphemeralToken: impl } as unknown as GithubAppClient;
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

const noSleep = () => Promise.resolve();

describe("isRetryableMintError", () => {
  it("retries 5xx/429/transport errors, not other 4xx", () => {
    assert.equal(isRetryableMintError(httpError(500)), true);
    assert.equal(isRetryableMintError(httpError(502)), true);
    assert.equal(isRetryableMintError(httpError(429)), true); // secondary rate limit
    assert.equal(isRetryableMintError(new Error("socket hangup")), true); // no status
    assert.equal(isRetryableMintError(httpError(403)), false);
    assert.equal(isRetryableMintError(httpError(404)), false);
    assert.equal(isRetryableMintError(httpError(422)), false);
  });
});

describe("mintEphemeralTokenWithRetry", () => {
  const OPTS = { installationId: 1 };

  it("returns the token on first success without sleeping", async () => {
    let calls = 0;
    const token = await mintEphemeralTokenWithRetry(
      fakeGithub(async () => {
        calls++;
        return TOKEN;
      }),
      OPTS,
      () => {
        throw new Error("sleep should not run");
      },
    );
    assert.equal(token, TOKEN);
    assert.equal(calls, 1);
  });

  it("retries transient 5xx failures and succeeds", async () => {
    let calls = 0;
    const slept: number[] = [];
    const token = await mintEphemeralTokenWithRetry(
      fakeGithub(async () => {
        calls++;
        if (calls < 3) throw httpError(500);
        return TOKEN;
      }),
      OPTS,
      async (ms) => {
        slept.push(ms);
      },
    );
    assert.equal(token, TOKEN);
    assert.equal(calls, 3);
    assert.deepEqual(slept, MINT_RETRY_DELAYS_MS);
  });

  it("does not retry 4xx — the request itself is wrong", async () => {
    let calls = 0;
    await assert.rejects(
      mintEphemeralTokenWithRetry(
        fakeGithub(async () => {
          calls++;
          throw httpError(422);
        }),
        OPTS,
        noSleep,
      ),
      /HTTP 422/,
    );
    assert.equal(calls, 1);
  });

  it("exhausts retries on a persistent outage and rethrows the last error", async () => {
    let calls = 0;
    const slept: number[] = [];
    await assert.rejects(
      mintEphemeralTokenWithRetry(
        fakeGithub(async () => {
          calls++;
          throw httpError(500);
        }),
        OPTS,
        async (ms) => {
          slept.push(ms);
        },
      ),
      /HTTP 500/,
    );
    assert.equal(calls, 1 + MINT_RETRY_DELAYS_MS.length);
    assert.deepEqual(slept, MINT_RETRY_DELAYS_MS);
  });
});
