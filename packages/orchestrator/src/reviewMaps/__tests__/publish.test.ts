import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ScmProvider } from "../../scm/types.js";
import type { Db } from "../../db/client.js";
import { attachReviewMap } from "../publish.js";

const BASE = {
  projectId: "p1",
  flowRunId: "fr1",
  pr: { number: 1, headSha: "sha" },
  repo: "o/r",
  reviewMarkdown: "",
  verdict: "COMMENT" as const,
  publicBaseUrl: "https://opencara.example/",
};

function hangingProvider(): ScmProvider {
  return {
    platform: "github",
    postReview: async () => {
      throw new Error("unused");
    },
    addComment: async () => {
      throw new Error("unused");
    },
    addLabel: async () => {
      throw new Error("unused");
    },
    getPullRequestState: async () => {
      throw new Error("unused");
    },
    listPullRequestFiles: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              files: [
                { path: "a.ts", status: "modified", additions: 1, deletions: 0 },
              ],
              prUrl: "u",
              truncated: false,
            }),
          60,
        ),
      ),
  };
}

describe("attachReviewMap", () => {
  it("times out without inserting an orphan row", async () => {
    let inserted = false;
    const db = {
      insert: () => ({
        values: async () => {
          inserted = true;
        },
      }),
    } as unknown as Db;
    const result = await attachReviewMap({
      ...BASE,
      db,
      provider: hangingProvider(),
      timeoutMs: 10,
    });
    assert.equal(result, null);
    // Give the losing build a beat to reach insertReviewMap.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(inserted, false);
  });
});
