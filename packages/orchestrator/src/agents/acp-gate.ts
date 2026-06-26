// Centralized adapter registry + spec builder for the ACP+MCP path.
// Started life as a feature-flagged cutover (#29) gating chat-only
// dispatch; #30 widened to all agent kinds, all dispatch paths (chat
// + test endpoint + flow nodes), and deleted the legacy stdin-JSON
// envelope, the fenced `opencara-call` parser, and the per-kind
// `kindsAdapter` machinery. ACP is now the only path.

import type {
  AcpHistoryTurn,
  AcpImageInput,
  AcpPermissionMode,
  AcpSpec,
  AgentSpec,
} from "@opencara/shared";

/**
 * Per-kind ACP adapter invocation. Adding a new kind is a one-line
 * append here.
 *
 * All adapters are invoked via `npx --yes` so devices never need a
 * global install — npx fetches and caches the latest version on first
 * use. No global `npm i -g` required; Node.js 20+ (already a
 * prerequisite) ships npx. Operators who want a pinned version can
 * override `agent.command` in the dashboard.
 *
 * - claude: `npx --yes --package=opencara@latest claude-acp` — our own
 *   thin shim (`packages/cli/src/bin/claude-acp.ts`) bundled in the
 *   opencara package. Wraps the local `claude` CLI; full Claude Code
 *   fidelity (CLAUDE.md, settings.json, MCP servers, OAuth auth).
 * - codex: `npx --yes @zed-industries/codex-acp@latest` — third-party
 *   Rust adapter that links the codex-rs SDK directly. optionalDeps
 *   pull the right platform binary on first use.
 * - opencode: `npx --yes opencode-ai@latest acp` — native ACP via the
 *   official `opencode` CLI's `acp` subcommand.
 * - pi: `npx --yes pi-acp@latest` — community ACP adapter for the pi
 *   coding agent.
 */
const ACP_ADAPTERS = new Map<string, { command: string; args: readonly string[] }>([
  [
    "claude",
    { command: "npx", args: ["--yes", "--package=opencara@latest", "claude-acp"] },
  ],
  [
    "codex",
    { command: "npx", args: ["--yes", "@zed-industries/codex-acp@latest"] },
  ],
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
  agent: { kind: string; name: string; cwd: string | null; args?: string[] };
  env: Record<string, string>;
  systemPromptMd: string;
  userPromptMd: string;
  history?: AcpHistoryTurn[];
  pageContext?: Record<string, unknown>;
  /**
   * When set, the device runs `session/load` with this id instead of
   * `session/new`. The orchestrator derives this from
   * `<sessionDir>/agent-session.json` (written after the prior run on
   * the same (repo, branch)) and only sets it when the persisted kind
   * matches the current agent's kind. The shim (e.g. claude-acp) is
   * responsible for mapping it onto the underlying CLI's resume
   * mechanism.
   */
  priorSessionId?: string;
  /**
   * Per-turn `--permission-mode` value forwarded to claude-acp (and any
   * future adapter that honours the same flag). Unset = the agent's
   * baked-in default — preserves prior behaviour for flow runs that
   * don't opt in. The chat panel surfaces this as a toolbar select +
   * "Plan mode" toggle.
   */
  permissionMode?: AcpPermissionMode;
  /**
   * Repo-relative path to a project-level agent instructions file. The
   * caller validated the SETTING via `validateInstructionsFileSetting`;
   * the actual stat-check happens on the device side (claude-acp) where
   * the worktree filesystem actually exists.
   *
   * When present, the ACP adapter strips its per-kind auto-discovery
   * (e.g. claude-acp drops `~/.claude/CLAUDE.md`) and injects this
   * file's content as the canonical project system prompt instead.
   * Unset = adapter keeps native discovery (chat / test runs without a
   * worktree, or projects opting out by clearing the setting). See #130.
   */
  instructionsFile?: string;
  /**
   * Image attachments for this turn (clipboard paste / drag-and-drop in
   * the chat panel). Appended to the ACP prompt as image content blocks;
   * shims without image support drop them. See #142.
   */
  images?: AcpImageInput[];
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
    images: opts.images ?? [],
    pageContextJson: hasMeaningfulContext(opts.pageContext)
      ? JSON.stringify(opts.pageContext)
      : undefined,
    ...(opts.priorSessionId ? { priorSessionId: opts.priorSessionId } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.instructionsFile ? { instructionsFile: opts.instructionsFile } : {}),
  };
  return {
    kind: opts.agent.name,
    command: adapter.command,
    // Adapter's own args first, then operator-configured extras (e.g.
    // `--model claude-opus-4-5` from the agent's DB `args` column). The
    // device passes these through to the ACP adapter binary (claude-acp),
    // which in turn appends them to the underlying CLI invocation.
    args: [...adapter.args, ...(opts.agent.args ?? [])],
    env: opts.env,
    cwd: opts.agent.cwd ?? undefined,
    acp,
  };
}

function hasMeaningfulContext(ctx: Record<string, unknown> | undefined): boolean {
  if (!ctx) return false;
  return Object.keys(ctx).length > 0;
}
