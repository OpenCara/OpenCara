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
 * Per-kind ACP adapter invocation. Adding a new kind is a one-line
 * append here.
 *
 * - codex: `npx --yes @zed-industries/codex-acp` — third-party Rust
 *   adapter that links the codex-rs SDK directly. The npm package's
 *   optionalDependencies pull the right platform binary on first use.
 * - claude: `claude-acp` — our own thin shim
 *   (`packages/cli/src/bin/claude-acp.ts`) that wraps the local
 *   `claude` CLI. No third-party in the critical path; full Claude Code
 *   fidelity (CLAUDE.md, settings.json, MCP servers, OAuth auth) by
 *   delegating to the actual binary. The bin ships in opencara@latest
 *   so paired devices have it on PATH after `npm i -g opencara`.
 */
const ACP_ADAPTERS = new Map<string, { command: string; args: readonly string[] }>([
  [
    "codex",
    { command: "npx", args: ["--yes", "@zed-industries/codex-acp"] },
  ],
  ["claude", { command: "claude-acp", args: [] }],
]);

/** Lowercase keys derived from the adapter map; match incoming kind case-insensitively. */
const ACP_KIND_ALLOWLIST = new Set(ACP_ADAPTERS.keys());

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
    const supported = [...ACP_KIND_ALLOWLIST].join(", ");
    return {
      useAcp: false,
      refuseReason:
        `OPENCARA_ACP is set but agent kind "${agentKind}" is not in the ACP cutover allowlist. ` +
        `Supported: ${supported}. Disable the flag or switch the agent to a supported kind.`,
    };
  }
  return { useAcp: true, refuseReason: null };
}

export interface BuildAcpSpecOpts {
  agent: { kind: string; name: string; cwd: string | null };
  env: Record<string, string>;
  systemPromptMd: string;
  userPromptMd: string;
  history?: AcpHistoryTurn[];
  pageContext?: Record<string, unknown>;
}

/**
 * Construct the AgentSpec for an ACP+MCP run. Callers should already
 * have confirmed eligibility via `checkAcpEligibility`.
 *
 * Throws if the agent's kind has no adapter mapping — defense in depth
 * against a caller that built the spec without checking eligibility.
 */
export function buildAcpSpec(opts: BuildAcpSpecOpts): AgentSpec {
  const adapter = ACP_ADAPTERS.get(opts.agent.kind.toLowerCase());
  if (!adapter) {
    throw new Error(
      `buildAcpSpec: no ACP adapter for agent kind "${opts.agent.kind}" — ` +
        `caller must run checkAcpEligibility first`,
    );
  }
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
    command: adapter.command,
    args: [...adapter.args],
    env: opts.env,
    cwd: opts.agent.cwd ?? undefined,
    acp,
  };
}

function hasMeaningfulContext(ctx: Record<string, unknown> | undefined): boolean {
  if (!ctx) return false;
  return Object.keys(ctx).length > 0;
}
