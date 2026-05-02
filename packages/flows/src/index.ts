import type { FlowDefinition } from "./types.js";
import { prReviewFlow } from "./builtin/pr-review.js";
import { prReviewMultiFlow } from "./builtin/pr-review-multi.js";
import { issueImplementFlow } from "./builtin/issue-implement.js";

export * from "./types.js";

export const builtinFlows: Record<string, FlowDefinition> = {
  [prReviewFlow.slug]: prReviewFlow,
  [prReviewMultiFlow.slug]: prReviewMultiFlow,
  [issueImplementFlow.slug]: issueImplementFlow,
};
