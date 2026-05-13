import type { FlowDefinition } from "../types.js";

const reviewerContext = {
  env: [
    "OPENCARA_REPO",
    "OPENCARA_PR_NUMBER",
    "OPENCARA_PR_HEAD_SHA",
    "OPENCARA_PR_BASE_SHA",
  ],
  stdinJson: true,
};

export const prReviewMultiFlow: FlowDefinition = {
  slug: "pr-review-multi",
  name: "Multi-agent pull request review",
  description:
    "On PR opened/synchronize, fan out to three reviewer agents (correctness, performance, style), synthesize their reviews into a single summary, then post it as a PR review comment. Link a different agent to each reviewer node from the flow detail page.",
  nodes: [
    {
      id: "trigger",
      kind: "github.pull_request",
      position: { x: 0, y: 160 },
      config: {
        actions: ["opened", "synchronize", "reopened"],
        branches: [],
        branchesIgnore: [],
        paths: [],
        pathsIgnore: [],
        labels: [],
        labelsIgnore: [],
        ignoreDrafts: false,
      },
    },
    {
      id: "reviewer_correctness",
      kind: "agent",
      position: { x: 280, y: 0 },
      config: {
        label: "Correctness reviewer",
        contextInjection: reviewerContext,

      },
    },
    {
      id: "reviewer_performance",
      kind: "agent",
      position: { x: 280, y: 160 },
      config: {
        label: "Performance reviewer",
        contextInjection: reviewerContext,

      },
    },
    {
      id: "reviewer_style",
      kind: "agent",
      position: { x: 280, y: 320 },
      config: {
        label: "Style reviewer",
        contextInjection: reviewerContext,

      },
    },
    {
      id: "synthesizer",
      kind: "agent",
      position: { x: 560, y: 160 },
      config: {
        label: "Review synthesizer",
        contextInjection: {
          // Synthesizer doesn't need PR env extras — its input is the
          // concatenated reviewer outputs delivered via stdin.
          env: [],
          stdinJson: true,
        },

      },
    },
    {
      id: "post",
      kind: "github.post_review",
      position: { x: 840, y: 160 },
      config: { event: "COMMENT" },
    },
  ],
  edges: [
    { id: "e_t_c", source: "trigger", target: "reviewer_correctness" },
    { id: "e_t_p", source: "trigger", target: "reviewer_performance" },
    { id: "e_t_s", source: "trigger", target: "reviewer_style" },
    { id: "e_c_s", source: "reviewer_correctness", target: "synthesizer" },
    { id: "e_p_s", source: "reviewer_performance", target: "synthesizer" },
    { id: "e_s_s", source: "reviewer_style", target: "synthesizer" },
    { id: "e_synth_post", source: "synthesizer", target: "post" },
  ],
};
