import type { FlowDefinition } from "./types.js";
import { issueLifecycleFlow } from "./builtin/issue-lifecycle.js";
import { prReviewFlow } from "./builtin/pr-review.js";
import { prReviewMultiFlow } from "./builtin/pr-review-multi.js";
import { issueImplementFlow } from "./builtin/issue-implement.js";
import { prReviewFixFlow } from "./builtin/pr-review-fix.js";

export * from "./types.js";

// The single unified lifecycle flow is the only auto-seeded built-in
// (issue #124). It supersedes the four stage-specific flows below by
// merging them into one graph with three trigger entry-points, so a
// project ends up with one flow to manage instead of four — and a
// single event no longer fans out to four flows with three immediately
// cancelled as `trigger_skip`.
export const builtinFlows: Record<string, FlowDefinition> = {
  [issueLifecycleFlow.slug]: issueLifecycleFlow,
};

export { issueLifecycleFlow };

// The legacy stage-specific flows are no longer seeded into new
// projects, but their definitions stay exported for reference and for
// the convergence step that disables their per-project rows. Existing
// projects keep any customised rows on disk; they are just disabled so
// they stop double-dispatching alongside the unified flow.
export const legacyBuiltinFlows: Record<string, FlowDefinition> = {
  [prReviewFlow.slug]: prReviewFlow,
  [prReviewMultiFlow.slug]: prReviewMultiFlow,
  [issueImplementFlow.slug]: issueImplementFlow,
  [prReviewFixFlow.slug]: prReviewFixFlow,
};

export const LEGACY_BUILTIN_FLOW_SLUGS = Object.keys(legacyBuiltinFlows);

export { prReviewFlow, prReviewMultiFlow, issueImplementFlow, prReviewFixFlow };
