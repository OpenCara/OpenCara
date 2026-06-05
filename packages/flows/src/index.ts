import type { FlowDefinition } from "./types.js";
import { developmentLifecycleFlow } from "./builtin/development-lifecycle.js";
import { prReviewFlow } from "./builtin/pr-review.js";
import { prReviewMultiFlow } from "./builtin/pr-review-multi.js";
import { issueImplementFlow } from "./builtin/issue-implement.js";
import { prReviewFixFlow } from "./builtin/pr-review-fix.js";

export * from "./types.js";

// Auto-seeded built-ins. The unified development-lifecycle flow (issue
// #124) is the always-on one — it merges the old four stage-specific
// flows into one graph with three trigger entry-points, so a single
// event no longer fans out to four flows with three cancelled as
// `trigger_skip`.
//
// The standalone single-reviewer `pr-review` is also seeded, but DISABLED
// by default (see DEFAULT_DISABLED_BUILTIN_FLOW_SLUGS): it's the simple
// one-agent alternative to the lifecycle's built-in 3-agent review fan-out,
// available as an opt-in template. Because it shares the lifecycle's
// `pull_request.opened` trigger, leaving it enabled alongside the lifecycle
// would post two reviews per PR — so the intended use is to enable it on a
// repo only where the always-on development-lifecycle is disabled.
export const builtinFlows: Record<string, FlowDefinition> = {
  [developmentLifecycleFlow.slug]: developmentLifecycleFlow,
  [prReviewFlow.slug]: prReviewFlow,
};

// Seeded into every project but inserted with `enabled = false`. The seeder
// only applies this on INSERT — it never flips a row a user has toggled.
export const DEFAULT_DISABLED_BUILTIN_FLOW_SLUGS = new Set<string>([
  prReviewFlow.slug,
]);

export { developmentLifecycleFlow, prReviewFlow };

// The remaining legacy stage-specific flows are no longer seeded into new
// projects, but their definitions stay exported for reference and for the
// convergence step that disables their per-project rows. Existing projects
// keep any customised rows on disk; they are just disabled so they stop
// double-dispatching alongside the unified flow.
export const legacyBuiltinFlows: Record<string, FlowDefinition> = {
  [prReviewMultiFlow.slug]: prReviewMultiFlow,
  [issueImplementFlow.slug]: issueImplementFlow,
  [prReviewFixFlow.slug]: prReviewFixFlow,
};

export const LEGACY_BUILTIN_FLOW_SLUGS = Object.keys(legacyBuiltinFlows);

export { prReviewMultiFlow, issueImplementFlow, prReviewFixFlow };
