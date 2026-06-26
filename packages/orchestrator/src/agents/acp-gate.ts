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
  agent: {
    kind: string;
    name: string;
    cwd: string | null;
    args?: string[];
    /**
     * Full ACP adapter args override (the `acp_args` column). When set and
     * non-empty, used verbatim as the adapter args — the kind-derived base args
     * and the per-kind model translation of `args` are bypassed. Null/empty =
     * derive from kind (the default path).
     */
    acpArgs?: string[] | null;
  };
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
  // Per-adapter model handling. The operator configures model selection in the
  // agent's DB `args` (e.g. `--model gpt-5.5`), but adapters disagree on how a
  // model is named: claude-acp accepts `--model` on argv, codex-acp accepts it
  // ONLY as a `-c model="…"` config override, and opencode's `acp` subcommand
  // has NO model flag at all (model comes from opencode config, optionally via
  // `{env:OPENCODE_MODEL}`). Forwarding the raw `--model`/`-m` to codex/opencode
  // made the adapter exit non-zero ("unexpected argument '--model'") and failed
  // the whole job. resolveAdapterInvocation translates it per kind.
  const { args, env } = resolveAdapterArgs(
    opts.agent.kind,
    adapter,
    { args: opts.agent.args, acpArgs: opts.agent.acpArgs },
    opts.env,
  );
  return {
    kind: opts.agent.name,
    command: adapter.command,
    args,
    env,
    cwd: opts.agent.cwd ?? undefined,
    acp,
  };
}

/**
 * The ACP adapter command (executable) for a kind — `npx`, `claude-acp`, … —
 * or undefined if the kind has no adapter. The command is always derived from
 * kind; only the args are overridable. Surfaced to the agent-config UI so it
 * can show the fixed command alongside the editable args.
 */
export function acpCommandFor(kind: string): string | undefined {
  return ACP_ADAPTERS.get(kind.toLowerCase())?.command;
}

/**
 * The adapter args that run by DEFAULT for a kind given the agent's configured
 * `args` (i.e. the kind base args + the per-kind model translation, exactly
 * what `buildAcpSpec` uses when there is no `acpArgs` override). Returns
 * undefined for an unknown kind. The UI pre-fills the editable args field with
 * this so "edit args" starts from the real default.
 */
export function defaultAcpArgsFor(
  kind: string,
  agentArgs: readonly string[] = [],
): string[] | undefined {
  const adapter = ACP_ADAPTERS.get(kind.toLowerCase());
  if (!adapter) return undefined;
  return resolveAdapterInvocation(kind, adapter.args, agentArgs, {}).args;
}

/**
 * Resolve the adapter (args, env) for dispatch, honouring a full `acpArgs`
 * override. A non-empty override is used verbatim (no kind base args, no model
 * translation) — the operator owns the line. Otherwise fall back to the
 * kind-derived default via resolveAdapterInvocation.
 */
export function resolveAdapterArgs(
  kind: string,
  adapter: { command: string; args: readonly string[] },
  agent: { args?: string[]; acpArgs?: string[] | null },
  baseEnv: Record<string, string>,
): { args: string[]; env: Record<string, string> } {
  if (agent.acpArgs && agent.acpArgs.length > 0) {
    return { args: [...agent.acpArgs], env: baseEnv };
  }
  return resolveAdapterInvocation(kind, adapter.args, agent.args ?? [], baseEnv);
}

/**
 * Split a model selection out of an agent's configured args. Recognises
 * `--model <v>`, `-m <v>`, `--model=<v>`, and `-m=<v>` (first occurrence wins).
 * Returns the model (if any) plus the remaining args with the model flag
 * removed, so callers can re-emit the model in an adapter-specific form.
 */
export function splitModelArg(
  args: readonly string[],
): { model?: string; rest: string[] } {
  const rest: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (model === undefined) {
      const eq = /^(?:--model|-m)=(.*)$/.exec(a);
      if (eq) {
        model = eq[1];
        continue;
      }
      if (a === "--model" || a === "-m") {
        const v = args[i + 1];
        if (v !== undefined) {
          model = v;
          i++; // consume the value token
        }
        // a bare trailing flag with no value is dropped (malformed)
        continue;
      }
    }
    rest.push(a);
  }
  return { model, rest };
}

/**
 * Build the (args, env) for an adapter invocation, translating the operator's
 * model selection into the form each adapter actually accepts:
 *   - codex    → `-c model="<v>"` (codex-acp config override; it has no --model)
 *   - opencode → `OPENCODE_MODEL` env (its `acp` subcommand has no model flag;
 *                model resolves through opencode config's `{env:OPENCODE_MODEL}`)
 *   - claude   → `--model <v>` on argv (claude-acp accepts it) — pass-through
 *   - other (e.g. pi, unverified) → unchanged pass-through
 * Non-model args are always preserved.
 */
export function resolveAdapterInvocation(
  kind: string,
  adapterArgs: readonly string[],
  agentArgs: readonly string[],
  baseEnv: Record<string, string>,
): { args: string[]; env: Record<string, string> } {
  const k = kind.toLowerCase();
  if (k === "codex") {
    const { model, rest } = splitModelArg(agentArgs);
    const modelArgs = model ? ["-c", `model=${JSON.stringify(model)}`] : [];
    return { args: [...adapterArgs, ...rest, ...modelArgs], env: baseEnv };
  }
  if (k === "opencode") {
    const { model, rest } = splitModelArg(agentArgs);
    const env = model ? { ...baseEnv, OPENCODE_MODEL: model } : baseEnv;
    return { args: [...adapterArgs, ...rest], env };
  }
  // claude accepts --model on argv; pi is unverified — preserve prior behaviour.
  return { args: [...adapterArgs, ...agentArgs], env: baseEnv };
}

function hasMeaningfulContext(ctx: Record<string, unknown> | undefined): boolean {
  if (!ctx) return false;
  return Object.keys(ctx).length > 0;
}
