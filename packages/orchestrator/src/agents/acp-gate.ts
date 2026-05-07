// Centralized feature flag + spec builder for the ACP+MCP cutover (#29).
// Both the chat route (per-page chat) and the agent-test endpoint (the
// dashboard's "Test agent" button) consult this module so they make the
// same dispatch decision — otherwise it's possible to hit the legacy
// path through one endpoint while the other has already cut over,
// which surfaced during testing v0.103.0 (#33 review note).
//
// #30 widens the allowlist and eventually deletes this file along with
// the legacy spec branch.

import type { AcpHistoryTurn, AcpSpec, AgentSpec } from "@opencara/shared";

/**
 * Process-wide flag. Read once at module-load (chat/test routes call
 * `isAcpEnabled()` per-request, but the boolean itself is captured at
 * import time so a deploy-with-flag-toggle requires a restart).
 */
const ACP_ENABLED = process.env["OPENCARA_ACP"] === "1";

/**
 * Agent kinds the ACP path supports today. Lowercased for the
 * comparison; the DB column uses the agentKindEnum so casing is
 * already canonical, but be defensive in case operator UI tooling
 * normalizes differently.
 */
const ACP_KIND_ALLOWLIST = new Set(["codex"]);

/**
 * The codex-acp adapter binary. `npx --yes` so devices don't need a
 * pre-install; the package's optionalDependencies pull the right
 * platform binary on first use. Pinned to a major in
 * packages/cli/package.json so adapter API changes don't surprise
 * a running deploy mid-session.
 */
const CODEX_ACP_COMMAND = "npx";
const CODEX_ACP_ARGS = ["--yes", "@zed-industries/codex-acp"];

export function isAcpEnabled(): boolean {
  return ACP_ENABLED;
}

export interface AcpEligibility {
  /** True iff this run should dispatch through ACP+MCP. */
  useAcp: boolean;
  /**
   * When `ACP_ENABLED` is on but the agent's kind is outside the
   * cutover allowlist, callers must refuse rather than silently fall
   * back. Surfaced as a 400 response so operators know the flag
   * isn't doing what they think.
   */
  refuseReason: string | null;
}

export function checkAcpEligibility(agentKind: string): AcpEligibility {
  if (!ACP_ENABLED) return { useAcp: false, refuseReason: null };
  const allowed = ACP_KIND_ALLOWLIST.has(agentKind.toLowerCase());
  if (!allowed) {
    return {
      useAcp: false,
      refuseReason:
        `OPENCARA_ACP is set but agent kind "${agentKind}" is not in the ACP cutover allowlist (only "codex" today). ` +
        `Disable the flag or pick a codex agent.`,
    };
  }
  return { useAcp: true, refuseReason: null };
}

export interface BuildAcpSpecOpts {
  agent: { name: string; cwd: string | null };
  env: Record<string, string>;
  systemPromptMd: string;
  userPromptMd: string;
  history?: AcpHistoryTurn[];
  pageContext?: Record<string, unknown>;
}

/**
 * Construct the AgentSpec for an ACP+MCP run. Callers should already
 * have confirmed eligibility via `checkAcpEligibility`.
 */
export function buildAcpSpec(opts: BuildAcpSpecOpts): AgentSpec {
  const acp: AcpSpec = {
    systemPromptMd: opts.systemPromptMd,
    userPromptMd: opts.userPromptMd,
    history: opts.history ?? [],
    pageContextJson: hasMeaningfulContext(opts.pageContext)
      ? JSON.stringify(opts.pageContext)
      : undefined,
  };
  return {
    kind: opts.agent.name,
    command: CODEX_ACP_COMMAND,
    args: [...CODEX_ACP_ARGS],
    env: opts.env,
    cwd: opts.agent.cwd ?? undefined,
    acp,
  };
}

function hasMeaningfulContext(ctx: Record<string, unknown> | undefined): boolean {
  if (!ctx) return false;
  return Object.keys(ctx).length > 0;
}
