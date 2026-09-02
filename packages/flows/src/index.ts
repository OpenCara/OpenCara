import type { FlowDefinition } from "./types.js";
import { developmentLifecycleFlow } from "./builtin/development-lifecycle.js";
import { prReviewFlow } from "./builtin/pr-review.js";
import { prReviewMultiFlow } from "./builtin/pr-review-multi.js";
import { issueImplementFlow } from "./builtin/issue-implement.js";
import { prReviewFixFlow } from "./builtin/pr-review-fix.js";

export * from "./types.js";

// The development cycle ships as FOUR single-stage built-ins, each with one
// trigger entry-point, linked by platform round-trips rather than in-graph
// edges: issue → implement → (PR opened) → multi review → (review submitted)
// → fix → (push) → single review → … Every project is seeded with all four.
// The engine's per-flow event pre-filter (flows/eventMatch.ts) keeps an
// event from minting cancelled runs on the three flows it can't match.
export const builtinFlows: Record<string, FlowDefinition> = {
  [issueImplementFlow.slug]: issueImplementFlow,
  [prReviewMultiFlow.slug]: prReviewMultiFlow,
  [prReviewFlow.slug]: prReviewFlow,
  [prReviewFixFlow.slug]: prReviewFixFlow,
};

export { issueImplementFlow, prReviewMultiFlow, prReviewFlow, prReviewFixFlow };

// The unified `development-lifecycle` graph that briefly replaced the four
// (issue #124) is no longer seeded. Its definition stays exported for the
// split migration in the orchestrator (flows/builtin.ts), which disables the
// per-project rows and carries drafts + node settings over to the four
// stage flows by node id.
export const legacyBuiltinFlows: Record<string, FlowDefinition> = {
  [developmentLifecycleFlow.slug]: developmentLifecycleFlow,
};

export const LEGACY_BUILTIN_FLOW_SLUGS = Object.keys(legacyBuiltinFlows);

export { developmentLifecycleFlow };
