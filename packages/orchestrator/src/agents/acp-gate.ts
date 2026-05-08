// Centralized adapter registry + spec builder for the ACP+MCP path.
// Started life as a feature-flagged cutover (#29) gating chat-only
// dispatch; #30 widened to all agent kinds, all dispatch paths (chat
// + test endpoint + flow nodes), and deleted the legacy stdin-JSON
// envelope, the fenced `opencara-call` parser, and the per-kind
// `kindsAdapter` machinery. ACP is now the only path.

import type { AcpHistoryTurn, AcpSpec, AgentSpec } from "@opencara/shared";

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
 * - opencode: `npx opencode-ai@latest acp` — native ACP via the
 *   official `opencode` CLI's `acp` subcommand.
 * - pi: `npx pi-acp@latest` — community ACP adapter for the pi coding
 *   agent.
 */
const ACP_ADAPTERS = new Map<string, { command: string; args: readonly string[] }>([
  [
    "codex",
    { command: "npx", args: ["--yes", "@zed-industries/codex-acp"] },
  ],
  ["claude", { command: "claude-acp", args: [] }],
  [
    "opencode",
    { command: "npx", args: ["--yes", "opencode-ai@latest", "acp"] },
  ],
  ["pi", { command: "npx", args: ["--yes", "pi-acp@latest"] }],
]);

/** Lowercase keys derived from the adapter map; match incoming kind case-insensitively. */
const ACP_KIND_ALLOWLIST = new Set(ACP_ADAPTERS.keys());

export interface AcpEligibility {
  /** True iff the agent kind has an ACP adapter mapping. */
  useAcp: boolean;
  /**
   * Human-readable refusal reason when the kind isn't in the
   * allowlist. Callers surface as a 400 / dispatch error so operators
   * see what went wrong (vs silent fallthrough to a non-existent path).
   */
  refuseReason: string | null;
}

export function checkAcpEligibility(agentKind: string): AcpEligibility {
  const allowed = ACP_KIND_ALLOWLIST.has(agentKind.toLowerCase());
  if (!allowed) {
    const supported = [...ACP_KIND_ALLOWLIST].join(", ");
    return {
      useAcp: false,
      refuseReason:
        `Agent kind "${agentKind}" is not supported. ` +
        `Supported: ${supported}. ` +
        `(The "custom" kind was removed in the v0.30 cutover; convert to a ` +
        `registered kind via the dashboard.)`,
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
