// Coverage for fetchWithConnectRetry inside AzureDevopsClient.request: a
// connect-stage failure (the request never left the process) gets retried
// a bounded number of times; anything else surfaces at once. A ~15min
// container→dev.azure.com connect outage failed post_review outright on
// flow run 01M31D37N0FC5ZPCQ3DAPWA7FP — these retries absorb that class
// of blip without ever risking a double POST.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AzureDevopsClient, AzureDevopsApiError } from "../client.js";

function patClient(): AzureDevopsClient {
  // PAT connections never touch db or entra — accessToken() decrypts the
  // stored token and returns it.
  const db = {} as never;
  const cipher = {
    decrypt: () => "pat-token",
    encrypt: (s: string) => s,
  } as never;
  const connection = {
    id: "conn-1",
    orgName: "contoso",
    authMode: "pat",
    accessTokenEnc: "enc",
    accessTokenExpiresAt: null,
    refreshTokenEnc: null,
  } as never;
  return new AzureDevopsClient({ db, cipher }, connection);
}

function connectTimeout(): TypeError {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
  return err;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AzureDevopsClient.request — connect retry", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("retries a connect timeout and returns the eventual response", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw connectTimeout();
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const res = await patClient().request<{ ok: boolean }>("https://dev.azure.com/x/_apis/y");
    assert.equal(calls, 3);
    assert.deepEqual(res, { ok: true });
  });

  it("gives up after the retry budget, throwing the last error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw connectTimeout();
    }) as typeof fetch;
    await assert.rejects(
      () => patClient().request("https://dev.azure.com/x/_apis/y"),
      (err: unknown) => err instanceof TypeError,
    );
    assert.equal(calls, 3);
  });

  it("does not retry mid-flight or ambiguous socket failures", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "UND_ERR_SOCKET" };
      throw err;
    }) as typeof fetch;
    await assert.rejects(() => patClient().request("https://dev.azure.com/x/_apis/y"));
    assert.equal(calls, 1);
  });

  it("does not retry HTTP error responses — they reached the server", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({ message: "boom" }, 500);
    }) as typeof fetch;
    await assert.rejects(
      () => patClient().request("https://dev.azure.com/x/_apis/y"),
      (err: unknown) => err instanceof AzureDevopsApiError && err.status === 500,
    );
    assert.equal(calls, 1);
  });

  it("retries pre-send syscall errors on POST too — nothing was transmitted", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        const err = new TypeError("fetch failed");
        (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
        throw err;
      }
      return jsonResponse({ id: 9 });
    }) as typeof fetch;
    const res = await patClient().request<{ id: number }>(
      "https://dev.azure.com/x/_apis/threads",
      { method: "POST", body: { content: "hi" } },
    );
    assert.equal(calls, 2);
    assert.equal(res.id, 9);
  });
});
