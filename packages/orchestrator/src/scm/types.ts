/**
 * The source-control provider seam.
 *
 * OpenCara talks to a hosting platform in a handful of narrow places: it posts
 * PR reviews and comments, labels things, mirrors issues/boards, and hands a
 * credential to an agent so it can clone and push. Everything else is
 * platform-agnostic. This module is the interface those places call through, so
 * adding a platform means writing an implementation rather than threading a
 * second branch through the flow engine.
 *
 * Scope note: this interface grows one capability group at a time, alongside the
 * code that needs it. Today it covers the **action nodes** (`scm.post_review`,
 * `scm.add_comment`, `scm.add_label`) — the surface the flow engine invokes
 * directly. Credential minting, clone specs, issue mirroring and board sync are
 * still GitHub-specific call sites and move behind this interface as the Azure
 * DevOps implementations for them land. Declaring them here before there are two
 * implementations to reconcile would be guesswork.
 */

/** Matches the `platform` pg enum in db/schema.ts. */
export type PlatformId = "github" | "azure_devops";

/**
 * The subset of a pull request the action surface needs. Deliberately not the
 * platform's full PR object: `number` is GitHub's PR number / Azure DevOps'
 * `pullRequestId`, and `headSha` is the commit a review is anchored to.
 */
export interface ScmPullRequestRef {
  number: number;
  headSha: string;
}

/**
 * Review verdicts, spelled with GitHub's enum because that is what the agent
 * verdict contract (agents/verdict.ts) already emits and what every stored flow
 * graph's `scm.post_review` config holds. Providers map it onto their own model
 * — Azure DevOps has no review-event concept and expresses the same intent as a
 * reviewer vote.
 */
export type ScmReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface PostReviewResult {
  /** Platform-native review id. Numeric on GitHub, a thread id on Azure DevOps. */
  reviewId: number | string;
  htmlUrl: string;
  /**
   * Set when the provider could not honour the requested verdict and fell back
   * to a plain comment — e.g. GitHub rejects APPROVE/REQUEST_CHANGES on a PR
   * opened by the same identity. Surfaced in the step output so an operator can
   * see the review landed with reduced force rather than silently.
   */
  downgradedFrom?: string;
}

export interface AddCommentResult {
  commentId: number | string;
  htmlUrl: string;
}

export interface AddLabelResult {
  /** Labels present after the call, as the platform reports them. */
  labels: string[];
}

/** Point-in-time state of a pull request, as re-read from the platform. */
export interface PullRequestState {
  /** "open" while reviewable; "closed" covers merged AND abandoned/closed. */
  state: "open" | "closed";
  merged: boolean;
  /** Label names currently on the PR. */
  labels: string[];
}

/**
 * A provider instance is bound to one repository and one set of credentials —
 * construct it per flow-run step via the registry, do not cache it across
 * projects. Implementations are expected to throw on API failure; the flow
 * engine turns a throw into a failed, rerunnable step.
 */
export interface ScmProvider {
  readonly platform: PlatformId;

  /**
   * Publish a review on a pull request. `body` is the agent's prose with the
   * `verdict:` line already stripped by the caller.
   */
  postReview(
    pr: ScmPullRequestRef,
    event: ScmReviewEvent,
    body: string,
  ): Promise<PostReviewResult>;

  /** Comment on a pull request or issue by its number. */
  addComment(issueNumber: number, body: string): Promise<AddCommentResult>;

  /** Add labels to a pull request or issue. Additive — never removes. */
  addLabel(issueNumber: number, labels: string[]): Promise<AddLabelResult>;

  /** Re-read a pull request's open/merged state and labels. */
  getPullRequestState(prNumber: number): Promise<PullRequestState>;
}
