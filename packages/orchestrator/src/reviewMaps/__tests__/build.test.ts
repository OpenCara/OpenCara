import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PullRequestFile, ScmProvider } from "../../scm/types.js";
import { buildReviewMap } from "../build.js";

interface StubProviderOpts {
  files?: PullRequestFile[];
  contents?: Record<string, string | Error>;
  truncated?: boolean;
  withFilesListing?: boolean;
  withReadFile?: boolean;
}

function stubProvider(opts: StubProviderOpts): {
  provider: ScmProvider;
  reads: string[];
} {
  const reads: string[] = [];
  const provider: ScmProvider = {
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
    ...(opts.withFilesListing !== false
      ? {
          listPullRequestFiles: async () => ({
            files: opts.files ?? [],
            prUrl: "https://github.com/o/r/pull/1",
            truncated: opts.truncated ?? false,
          }),
        }
      : {}),
    ...(opts.withReadFile !== false
      ? {
          readFileAtRef: async (path: string) => {
            reads.push(path);
            const c = opts.contents?.[path];
            if (c instanceof Error) throw c;
            return c ?? null;
          },
        }
      : {}),
  };
  return { provider, reads };
}

const BASE = {
  pr: { number: 1, headSha: "sha1" },
  repo: "o/r",
  reviewMarkdown: "",
  verdict: "COMMENT" as const,
};

describe("buildReviewMap", () => {
  it("returns null when the provider cannot list files", async () => {
    const { provider } = stubProvider({ withFilesListing: false });
    assert.equal(await buildReviewMap({ ...BASE, provider }), null);
  });

  it("builds a graph with edges from fetched contents", async () => {
    const { provider } = stubProvider({
      files: [
        { path: "src/app.ts", status: "modified", additions: 5, deletions: 1 },
        { path: "src/util.ts", status: "modified", additions: 3, deletions: 0 },
      ],
      contents: {
        "src/app.ts": `import "./util";`,
        "src/util.ts": `export const x = 1;`,
      },
    });
    const graph = await buildReviewMap({ ...BASE, provider });
    assert.ok(graph);
    assert.equal(graph.files.length, 2);
    assert.deepEqual(
      graph.edges.map((e) => [e.source, e.target]),
      [["src/app.ts", "src/util.ts"]],
    );
    assert.equal(graph.totals.files, 2);
    assert.equal(graph.totals.additions, 8);
    assert.equal(graph.groups.length, 1);
  });

  it("never fetches content for removed files", async () => {
    const { provider, reads } = stubProvider({
      files: [
        { path: "src/gone.ts", status: "removed", additions: 0, deletions: 9 },
        { path: "src/live.ts", status: "modified", additions: 2, deletions: 0 },
      ],
      contents: { "src/live.ts": "const x = 1;" },
    });
    const graph = await buildReviewMap({ ...BASE, provider });
    assert.ok(graph);
    assert.deepEqual(reads, ["src/live.ts"]);
  });

  it("tolerates per-file fetch failures", async () => {
    const { provider } = stubProvider({
      files: [
        { path: "a.ts", status: "modified", additions: 1, deletions: 0 },
        { path: "b.ts", status: "modified", additions: 1, deletions: 0 },
      ],
      contents: {
        "a.ts": new Error("boom"),
        "b.ts": "",
      },
    });
    const graph = await buildReviewMap({ ...BASE, provider });
    assert.ok(graph);
    assert.equal(graph.files.length, 2);
  });

  it("marks the graph truncated when the listing hit the cap", async () => {
    const { provider } = stubProvider({
      truncated: true,
      files: [
        { path: "a.ts", status: "modified", additions: 1, deletions: 0 },
      ],
      contents: {},
    });
    const graph = await buildReviewMap({ ...BASE, provider });
    assert.ok(graph);
    assert.deepEqual(graph.truncated, { listedFiles: 1 });
  });

  it("attaches findings parsed from the review body", async () => {
    const { provider } = stubProvider({
      files: [
        { path: "src/app.ts", status: "modified", additions: 5, deletions: 1 },
      ],
      contents: { "src/app.ts": "" },
    });
    const graph = await buildReviewMap({
      ...BASE,
      provider,
      reviewMarkdown: "- blocker: src/app.ts:9 leaks the fd",
    });
    assert.ok(graph);
    const f = graph.files[0]!;
    assert.equal(f.findings.length, 1);
    assert.equal(f.findings[0]!.severity, "high");
    assert.equal(f.findings[0]!.line, 9);
    assert.equal(graph.totals.filesWithFindings, 1);
  });
});
