import type { FlowDefinition } from "./types.js";
import { developmentLifecycleFlow } from "./builtin/development-lifecycle.js";
import { prReviewFlow } from "./builtin/pr-review.js";
import { prReviewMultiFlow } from "./builtin/pr-review-multi.js";
import { issueImplementFlow } from "./builtin/issue-implement.js";
import { prReviewFixFlow } from "./builtin/pr-review-fix.js";

export * from "./types.js";

// The single unified development-lifecycle flow is the only auto-seeded
// built-in (issue #124). It merges the old four stage-specific flows into
// one graph with three trigger entry-points, so a single event no longer
// fans out to four flows with three cancelled as `trigger_skip`. Single
// vs. multi review is handled *inside* its review stage (add/remove
// reviewer nodes), not by a separate flow.
export const builtinFlows: Record<string, FlowDefinition> = {
  [developmentLifecycleFlow.slug]: developmentLifecycleFlow,
};

export { developmentLifecycleFlow };

// The legacy stage-specific flows are no longer seeded into new projects,
// but their definitions stay exported for reference and for the convergence
// step that disables their per-project rows. Existing projects keep any
// customised rows on disk; they are just disabled so they stop
// double-dispatching alongside the unified flow.
export const legacyBuiltinFlows: Record<string, FlowDefinition> = {
  [prReviewFlow.slug]: prReviewFlow,
  [prReviewMultiFlow.slug]: prReviewMultiFlow,
  [issueImplementFlow.slug]: issueImplementFlow,
  [prReviewFixFlow.slug]: prReviewFixFlow,
};

export const LEGACY_BUILTIN_FLOW_SLUGS = Object.keys(legacyBuiltinFlows);

export { prReviewFlow, prReviewMultiFlow, issueImplementFlow, prReviewFixFlow };
