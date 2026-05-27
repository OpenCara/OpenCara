// Agent kinds shipped by the orchestrator. The list is the
// `agent_kind` Postgres enum and the source of truth for which kinds
// are valid in `agents.kind` rows. The actual ACP adapter for each
// kind lives in `acp-gate.ts:ACP_ADAPTERS`.
//
// Pre-#30 history: this file used to host per-kind `AgentKindAdapter`
// objects that built CLI invocations (claude --resume, codex exec
// resume, etc.) for the legacy stdin-JSON dispatch path. The cutover
// in #30 deleted that path entirely; per-kind specifics now live
// inside the per-kind ACP adapter binaries (claude-acp, codex-acp,
// opencode acp, pi-acp).

export type AgentKind = "claude" | "codex" | "opencode" | "pi";

export const AGENT_KINDS: AgentKind[] = ["claude", "codex", "opencode", "pi"];

export function isAgentKind(s: unknown): s is AgentKind {
  return typeof s === "string" && (AGENT_KINDS as string[]).includes(s);
}

/**
 * Per-kind operator hints surfaced in the AgentsPage UI. Not validated
 * server-side — informational only — but the dashboard uses these to
 * tell operators what env they need to set up so the device's spawned
 * adapter can authenticate.
 */
export const AUTH_HINTS: Record<AgentKind, Array<{ name: string; description: string }>> = {
  claude: [
    {
      name: "ANTHROPIC_API_KEY",
      description:
        "Anthropic API key. Required for any flow that sets a project " +
        "instructions file: claude-acp passes `--bare` in that case so " +
        "Claude skips keychain reads (and the `~/.claude/CLAUDE.md` " +
        "auto-discovery that previously overrode flow contracts — see #130). " +
        "For chat / test runs with no worktree, `claude auth login` tokens " +
        "in ~/.claude/auth.json still work as a fallback. Or wire your own " +
        "credential source via the `apiKeyHelper` field in a settings file " +
        "passed with `--settings`.",
    },
  ],
  codex: [
    {
      name: "OPENAI_API_KEY",
      description:
        "OpenAI API key. ChatGPT-subscription auth from `codex login` does NOT " +
        "work in remote-project contexts (the codex-acp adapter rejects it); " +
        "set the env var explicitly in the agent's env field.",
    },
  ],
  opencode: [
    {
      name: "ANTHROPIC_API_KEY / OPENAI_API_KEY",
      description:
        "Provider env var depends on the model selected in opencode's config — " +
        "set whichever matches.",
    },
  ],
  pi: [
    {
      name: "ANTHROPIC_API_KEY / OPENAI_API_KEY / KIMI_API_KEY / MINIMAX_CN_API_KEY / …",
      description:
        "Whichever provider you select via `--provider X --model Y` in args. " +
        "Run `pi --list-models` once on the device to see options.",
    },
  ],
};
