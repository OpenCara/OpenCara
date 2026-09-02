// Pins the platform-specific link shapes the Activity feed derives from the
// compact subject slice extracted in SQL (see activity.ts subjectJsonExpr).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSubject, repoWebUrl, type ActivityProject } from "../activitySubject.js";

const gh: ActivityProject = {
  id: "p1",
  owner: "acme",
  name: "widgets",
  platform: "github",
  webUrl: "https://github.com/acme/widgets",
};
const azdo: ActivityProject = {
  id: "p2",
  owner: "org/team",
  name: "repo",
  platform: "azure_devops",
  webUrl: "https://dev.azure.com/org/team/_git/repo/",
};

describe("repoWebUrl", () => {
  it("prefers webUrl and strips a trailing slash", () => {
    assert.equal(repoWebUrl(azdo), "https://dev.azure.com/org/team/_git/repo");
  });
  it("falls back to github.com/{owner}/{name} for github projects", () => {
    assert.equal(
      repoWebUrl({ ...gh, webUrl: null }),
      "https://github.com/acme/widgets",
    );
  });
  it("has no fallback for azure projects without webUrl", () => {
    assert.equal(repoWebUrl({ ...azdo, webUrl: null }), null);
  });
});

describe("buildSubject", () => {
  it("returns null for missing or unknown slices", () => {
    assert.equal(buildSubject(null, gh), null);
    assert.equal(buildSubject({ kind: "mystery", number: 1 }, gh), null);
    assert.equal(buildSubject({ kind: "pull_request", number: null }, gh), null);
  });

  it("links github pull requests", () => {
    const s = buildSubject({ kind: "pull_request", number: 12, title: "Fix" }, gh);
    assert.deepEqual(s, {
      kind: "pull_request",
      number: 12,
      title: "Fix",
      url: "https://github.com/acme/widgets/pull/12",
      label: "PR #12",
    });
  });

  it("links azure pull requests with the /pullrequest/ shape", () => {
    const s = buildSubject({ kind: "pull_request", number: "7" }, azdo);
    assert.equal(s?.url, "https://dev.azure.com/org/team/_git/repo/pullrequest/7");
    assert.equal(s?.number, 7);
    assert.equal(s?.title, null);
  });

  it("links github issues", () => {
    const s = buildSubject({ kind: "issue", number: 3, title: "Bug" }, gh);
    assert.equal(s?.kind, "issue");
    assert.equal(s?.url, "https://github.com/acme/widgets/issues/3");
    assert.equal(s?.label, "Issue #3");
  });

  it("treats an issue-keyed payload with isPr as a pull request", () => {
    // issue_comment on a PR: GitHub puts the PR under `issue` with a
    // `pull_request` sub-object.
    const s = buildSubject({ kind: "issue", number: 5, isPr: true }, gh);
    assert.equal(s?.kind, "pull_request");
    assert.equal(s?.url, "https://github.com/acme/widgets/pull/5");
  });

  it("links azure work items one level above _git", () => {
    const s = buildSubject(
      { kind: "work_item", number: 301, title: { oldValue: "Old", newValue: "New" } },
      azdo,
    );
    assert.equal(s?.url, "https://dev.azure.com/org/team/_workitems/edit/301");
    assert.equal(s?.title, "New");
    assert.equal(s?.label, "WI #301");
  });

  it("describes pushes by branch with the compare url", () => {
    const s = buildSubject(
      { kind: "push", ref: "refs/heads/main", compare: "https://github.com/acme/widgets/compare/a...b" },
      gh,
    );
    assert.equal(s?.label, "push main");
    assert.equal(s?.url, "https://github.com/acme/widgets/compare/a...b");
    assert.equal(s?.number, null);
  });

  it("still labels a subject when the project is unknown", () => {
    const s = buildSubject({ kind: "pull_request", number: 9 }, null);
    assert.equal(s?.label, "PR #9");
    assert.equal(s?.url, null);
  });

  it("prefers a browser url carried by the payload (Azure PR resource _links.web)", () => {
    const url = "https://dev.azure.com/org/team/_git/repo/pullrequest/60";
    assert.equal(
      buildSubject({ kind: "pull_request", number: 60, title: "T", url }, azdo)?.url,
      url,
    );
    // Even without a project row the payload url still links.
    assert.equal(buildSubject({ kind: "pull_request", number: 60, url }, null)?.url, url);
  });
  it("ignores a non-http payload url and falls back to the derived one", () => {
    assert.equal(
      buildSubject({ kind: "pull_request", number: 60, url: "javascript:alert(1)" }, azdo)?.url,
      "https://dev.azure.com/org/team/_git/repo/pullrequest/60",
    );
  });
});
