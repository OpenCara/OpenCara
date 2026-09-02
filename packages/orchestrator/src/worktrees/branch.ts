/**
 * Which git branch an agent attempt's worktree checks out, derived from the
 * trigger that started the flow run. Replaces the old per-node
 * `worktree.branchName` template: operators no longer configure a branch, and
 * every attempt gets its own checkout so nothing depends on two runs
 * computing the same name.
 *
 *   - PR trigger      → the PR head ref, cloned as-is (review / review-fix)
 *   - issue trigger   → `opencara/issue-<n>`, branched off `fromBranch`
 *   - anything else   → `opencara/run-<flow run id>`, branched off `fromBranch`
 */
export interface DeriveWorktreeBranchInput {
  /**
   * What the trigger promised: a PR-shaped event must yield a head ref, an
   * issue-shaped one an issue number. The engine builds those contexts
   * best-effort (a GitHub 5xx is logged, not thrown), so the deriver is
   * where a missing one turns into a loud failure instead of silently
   * branching `opencara/run-<id>` off the default branch.
   */
  expected: "pr" | "issue" | null;
  prHeadRef: string | null | undefined;
  issueNumber: number | null | undefined;
  flowRunId: string;
  /** Rendered `worktree.fromBranch`; empty/null = project default branch. */
  fromBranch: string | null | undefined;
  defaultBranch: string | null | undefined;
}

export type WorktreeBranchSource = "pr" | "issue" | "run";

export interface DerivedWorktreeBranch {
  branch: string;
  /** Base ref passed to `worktree create --from-branch` ("" = clone default). */
  fromBranch: string;
  source: WorktreeBranchSource;
}

export class WorktreeBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeBranchError";
  }
}

export function deriveWorktreeBranch(input: DeriveWorktreeBranchInput): DerivedWorktreeBranch {
  if (input.expected === "pr" && !(input.prHeadRef && input.prHeadRef.length > 0)) {
    throw new WorktreeBranchError(
      "worktree: this run was triggered by a pull request but the PR head ref is unavailable (the PR context fetch failed — see the flow-engine log); refusing to check out a branch off the default branch instead",
    );
  }
  if (input.expected === "issue" && !(input.issueNumber != null && Number.isFinite(input.issueNumber))) {
    throw new WorktreeBranchError(
      "worktree: this run was triggered for an issue but the issue number is unavailable (the issue context fetch failed — see the flow-engine log); refusing to derive a run-scoped branch instead",
    );
  }
  if (input.prHeadRef && input.prHeadRef.length > 0) {
    // branch === fromBranch is the CLI's "check out the existing remote
    // branch" path; it never creates a new ref for PR-triggered runs.
    return { branch: input.prHeadRef, fromBranch: input.prHeadRef, source: "pr" };
  }
  const base =
    input.fromBranch && input.fromBranch.length > 0
      ? input.fromBranch
      : (input.defaultBranch ?? "");
  if (input.issueNumber != null && Number.isFinite(input.issueNumber)) {
    return { branch: `opencara/issue-${input.issueNumber}`, fromBranch: base, source: "issue" };
  }
  return { branch: `opencara/run-${input.flowRunId.toLowerCase()}`, fromBranch: base, source: "run" };
}

/**
 * On-device slug for one attempt's checkout + session dir
 * (`~/.opencara/work/<key>/checkout`). Keyed by the flow_run_steps id so two
 * parallel pool slots — or a rerun — never collide; recorded in
 * `worktree_pins.key` so cleanup can address it later.
 */
export function worktreeKeyForStep(ownerRepo: string, flowRunStepId: string): string {
  return `${ownerRepo}/step-${flowRunStepId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}
