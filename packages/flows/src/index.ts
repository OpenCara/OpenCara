import type { FlowDefinition } from "./types.js";
import { prReviewFlow } from "./builtin/pr-review.js";

export * from "./types.js";

export const builtinFlows: Record<string, FlowDefinition> = {
  [prReviewFlow.slug]: prReviewFlow,
};
