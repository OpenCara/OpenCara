// Per-page chat skills. The chat panel sends a `pageContext.page` discriminator
// on every turn; the registry below maps it to a builder that returns:
//   - the markdown the agent sees (a "skill" envelope describing what's
//     actionable on this page and the schema of any opencara-call kinds
//     it can emit), and
//   - hydrated server-side data injected into the agent's stdin alongside
//     the user message (so the agent doesn't have to fetch or guess).
//
// Auth model: the agent never holds a token. It emits a fenced
// ```opencara-call``` block on stdout; the CLI parses the block and proxies
// the call back to the orchestrator over its already-authed WebSocket
// connection. New mutating kinds need an entry in:
//   - shared/host-protocol.ts (AgentCallSchema discriminated-union variant)
//   - cli/src/runner/agentCallParser.ts (VARIANT_SCHEMAS)
//   - orchestrator/src/agent-calls/<kind>.ts (server-side handler)
//   - orchestrator/src/dispatch/devices.ts applyAgentCall switch
// — and an entry in the per-page builder's skill markdown so the agent knows
// it exists.

import type { Db } from "../db/client.js";
import { issueCanvasBuilder } from "./skills/issueCanvas.js";
import { projectDetailBuilder } from "./skills/projectDetail.js";
import { projectFlowDetailBuilder } from "./skills/projectFlowDetail.js";
import { flowTemplateDetailBuilder } from "./skills/flowTemplateDetail.js";
import { flowRunDetailBuilder } from "./skills/flowRunDetail.js";
import { projectPmBuilder } from "./skills/projectPm.js";

export interface SkillEnvelope {
  /** Stable identifier the agent author can match on. */
  name: string;
  /** Markdown describing what the skill exposes and how to invoke it. */
  instructions: string;
  /** Resolved API base — informational only; the agent doesn't make HTTP
   * calls itself. Useful for log/debug output. */
  baseUrl: string;
  /** The agent's run id, useful for log correlation. */
  runId: string;
}

/**
 * Shape of pageContext the chat route forwards to builders. Mirrors the
 * fields ChatPanel sets in apps/web. Optional everywhere — a builder that
 * needs a missing field must return null.
 */
export interface PageContextLike {
  /** Set by ChatPanel to a registered page id, or null when the URL doesn't
   * match any pattern. Server treats both undefined and null as "no skill". */
  page?: string | null;
  pathname?: string;
  projectId?: string;
  flowSlug?: string;
  flowRunId?: string;
  selectedNodeId?: string;
  data?: Record<string, unknown>;
  canvas?: {
    kind: "issue";
    projectId: string;
    issueNumber: number;
    selection?: { text: string } | null;
  };
}

export interface PageSkillContext {
  pageContext: PageContextLike;
  user: { id: string };
  baseUrl: string;
  runId: string;
  db: Db;
}

export interface PageSkillResult {
  skill: SkillEnvelope;
  /** Top-level keys merged into stdinJson alongside `skill`. */
  hydrated: Record<string, unknown>;
  /**
   * Project the run is scoped to for agent-call gating. The dispatcher
   * uses this to decide which project's resources can be mutated.
   * Builders for read-only pages may return null.
   */
  projectScope?: string | null;
  /**
   * If set, chat.ts MUST refuse the request with this message and a 403.
   * Used by builders that validate resource visibility before the agent
   * sees any hydrated data (e.g. canvas builder confirms project exists).
   */
  authError?: string;
}

export type PageSkillBuilder = (
  ctx: PageSkillContext,
) => Promise<PageSkillResult | null>;

const REGISTRY: Record<string, PageSkillBuilder> = {
  "issue-canvas": issueCanvasBuilder,
  "project-detail": projectDetailBuilder,
  "project-flow-detail": projectFlowDetailBuilder,
  "flow-template-detail": flowTemplateDetailBuilder,
  "flow-run-detail": flowRunDetailBuilder,
  "project-pm": projectPmBuilder,
};

/**
 * Resolve a builder for the given page id, or return null when none is
 * registered. Null callers (legacy / unknown pages) keep today's
 * pathname-only context — explicit back-compat.
 */
export async function resolvePageSkill(
  ctx: PageSkillContext,
): Promise<PageSkillResult | null> {
  const page = ctx.pageContext.page;
  if (!page) return null;
  const builder = REGISTRY[page];
  if (!builder) return null;
  return builder(ctx);
}
