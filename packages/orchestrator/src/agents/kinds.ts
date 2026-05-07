// Per-kind agent adapters. Each adapter knows how to invoke ONE
// specific coding-agent CLI in non-interactive mode and how to
// resume a prior conversation. The rest of the engine treats agents
// as opaque — it only sees `Invocation` objects and `parseSessionId`
// callbacks; this file is the only place that knows the difference
// between `claude --resume` and `codex exec resume`.
//
// Verified flag/output shapes against installed binaries on
// 2026-05-06 (claude docs: https://code.claude.com/docs/en/cli-reference;
// codex 0.116.0 exec --help; opencode docs at opencode.ai;
// pi-coding-agent README at github.com/badlogic/pi-mono).

import { randomUUID } from "node:crypto";

export type AgentKind = "claude" | "codex" | "opencode" | "pi" | "custom";

export const AGENT_KINDS: AgentKind[] = ["claude", "codex", "opencode", "pi", "custom"];

export function isAgentKind(s: unknown): s is AgentKind {
  return typeof s === "string" && (AGENT_KINDS as string[]).includes(s);
}

export interface Invocation {
  command: string;
  args: string[];
  /** Extra env merged on top of agent.env (auth keys, behaviour flags). */
  extraEnv?: Record<string, string>;
  /** Set when the orchestrator generated the session id up-front (claude
   *  via `--session-id <uuid>`). The dispatch persists this regardless
   *  of stdout — for the other kinds we discover the id via parseSessionId. */
  preassignedSessionId?: string;
}

export interface BuildInvocationOpts {
  prompt: string;
  /** Worktree root the agent runs in. */
  cwd: string;
  /** Persistent per-PR-branch dir on the device. The agent can write
   *  scratchpad files here that survive across iterations. */
  sessionDir: string;
  /** When non-null: resume this conversation. When null: fresh run. */
  resumeSessionId: string | null;
  /** Operator's `agent.args` — appended to the adapter's base args.
   *  Typical use: pi takes `--provider X --model Y` here. */
  extraArgs: string[];
}

export interface AgentKindAdapter {
  kind: AgentKind;
  buildInvocation(opts: BuildInvocationOpts): Invocation;
  /** Pull the session id out of the agent's captured stdout. For claude
   *  we generate the id up-front and pass it via --session-id, so
   *  parseSessionId returns the preassigned value. For codex/opencode/
   *  pi we read line-1 of the JSONL output. Returns null if not
   *  parseable — caller logs and leaves the persisted id unchanged. */
  parseSessionId(stdoutCaptured: string, preassignedSessionId: string | undefined): string | null;
  /** Auth env vars the operator typically needs to set on the agent
   *  record. Surfaced as hints in the AgentsPage UI; not validated. */
  authHints: Array<{ name: string; description: string }>;
}

// ─── claude (Claude Code) ────────────────────────────────────────
//
// CLI ref: https://code.claude.com/docs/en/cli-reference
// Resume model: orchestrator generates a UUID, passes via
// `--session-id <uuid>` on first run, then `--resume <uuid>` on
// subsequent runs. No stdout parsing needed for the id.

const claudeAdapter: AgentKindAdapter = {
  kind: "claude",
  buildInvocation({ prompt, resumeSessionId, extraArgs }) {
    const sessionId = resumeSessionId ?? randomUUID();
    const sessionFlag = resumeSessionId
      ? ["--resume", resumeSessionId]
      : ["--session-id", sessionId];
    return {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "json",
        // Agents run unattended in a worktree the orchestrator owns;
        // there's no human in the loop to approve tool use. Equivalent
        // to `--permission-mode bypassPermissions`.
        "--dangerously-skip-permissions",
        ...sessionFlag,
        ...extraArgs,
        prompt,
      ],
      preassignedSessionId: sessionId,
    };
  },
  parseSessionId(_stdout, preassigned) {
    // We always know the id: either we picked it (first run) or we
    // passed it back in (resume).
    return preassigned ?? null;
  },
  authHints: [
    {
      name: "ANTHROPIC_API_KEY",
      description:
        "Anthropic API key. Or sign in once on the device with `claude auth login` (token persists in ~/.claude).",
    },
  ],
};

// ─── codex (OpenAI Codex CLI) ────────────────────────────────────
//
// `codex exec` is the headless mode; `codex exec resume <id>`
// continues a prior session. `--json` makes the very first stdout
// line a `session_meta` JSONL frame whose `payload.id` is the UUID.

const codexAdapter: AgentKindAdapter = {
  kind: "codex",
  buildInvocation({ prompt, resumeSessionId, extraArgs }) {
    const baseArgs = [
      "--json",
      // The orchestrator already runs the agent in a fresh worktree
      // (which is a git repo from `git clone --depth 1`), so the
      // git-repo check is redundant. Keeping it on would error if the
      // agent kind is ever paired with a non-worktree dispatch.
      "--skip-git-repo-check",
      // Headless: never prompt for approval. (Default policies prompt
      // on tool use; --help recommends `never` for non-interactive.)
      "-a",
      "never",
    ];
    if (resumeSessionId) {
      return {
        command: "codex",
        args: ["exec", "resume", resumeSessionId, ...baseArgs, ...extraArgs, prompt],
      };
    }
    return {
      command: "codex",
      args: ["exec", ...baseArgs, ...extraArgs, prompt],
    };
  },
  parseSessionId(stdout) {
    const firstLine = firstNonEmptyLine(stdout);
    if (!firstLine) return null;
    try {
      const obj = JSON.parse(firstLine) as { type?: string; payload?: { id?: unknown } };
      if (obj.type === "session_meta" && typeof obj.payload?.id === "string") {
        return obj.payload.id;
      }
    } catch {
      /* fall through */
    }
    return null;
  },
  authHints: [
    {
      name: "OPENAI_API_KEY",
      description:
        "OpenAI API key. Or run `codex login --with-api-key` once on the device to persist into ~/.codex/auth.json.",
    },
  ],
};

// ─── opencode ───────────────────────────────────────────────────
//
// `opencode run --format json` emits one JSON event per line, every
// frame includes `sessionID`. `--session <id>` resumes.

const opencodeAdapter: AgentKindAdapter = {
  kind: "opencode",
  buildInvocation({ prompt, resumeSessionId, extraArgs }) {
    const args = [
      "run",
      "--format",
      "json",
      // Headless: skip permission confirmations on tool use.
      "--dangerously-skip-permissions",
    ];
    if (resumeSessionId) {
      args.push("--session", resumeSessionId);
    }
    args.push(...extraArgs, prompt);
    return { command: "opencode", args };
  },
  parseSessionId(stdout) {
    const firstLine = firstNonEmptyLine(stdout);
    if (!firstLine) return null;
    try {
      const obj = JSON.parse(firstLine) as { sessionID?: unknown };
      if (typeof obj.sessionID === "string") return obj.sessionID;
    } catch {
      /* fall through */
    }
    return null;
  },
  authHints: [
    {
      name: "ANTHROPIC_API_KEY / OPENAI_API_KEY",
      description:
        "Provider env var depends on the model you select in opencode's config — set whichever matches.",
    },
  ],
};

// ─── pi (@mariozechner/pi-coding-agent) ─────────────────────────
//
// `pi --mode json` emits one JSONL event per line, line-1 is the
// session header `{"type":"session","id":"<uuid>",...}`. `--session
// <id>` resumes (accepts a partial UUID too, but we always pass
// the full one). Provider/model selection is via operator's
// agent.args (e.g. `--provider kimi-coding --model kimi-k2-thinking`).

const piAdapter: AgentKindAdapter = {
  kind: "pi",
  buildInvocation({ prompt, resumeSessionId, extraArgs }) {
    const args = [
      "--mode",
      "json",
      // Skip update-check + telemetry HTTPS calls on every run.
      "--offline",
      // Don't auto-load CLAUDE.md / AGENTS.md from the worktree (the
      // agent has the repo as cwd and may pick up unrelated rules).
      "--no-context-files",
    ];
    if (resumeSessionId) {
      args.push("--session", resumeSessionId);
    }
    args.push(...extraArgs, prompt);
    return { command: "pi", args };
  },
  parseSessionId(stdout) {
    const firstLine = firstNonEmptyLine(stdout);
    if (!firstLine) return null;
    try {
      const obj = JSON.parse(firstLine) as { type?: string; id?: unknown };
      if (obj.type === "session" && typeof obj.id === "string") return obj.id;
    } catch {
      /* fall through */
    }
    return null;
  },
  authHints: [
    {
      name: "ANTHROPIC_API_KEY / OPENAI_API_KEY / KIMI_API_KEY / MINIMAX_CN_API_KEY / …",
      description:
        "Whichever provider you select via `--provider X --model Y` in args. Run `pi --list-models` once to see options.",
    },
  ],
};

// ─── custom (escape hatch — no resume) ──────────────────────────
//
// `command`, `args`, `cwd` from the agents row used as-is. No
// session id is parsed or persisted; subsequent runs can't resume.

const customAdapter: AgentKindAdapter = {
  kind: "custom",
  buildInvocation() {
    // The engine's agentRunner uses the agent row's command/args directly
    // for kind=custom and never calls into this adapter for invocation
    // construction. The body here is for completeness / type safety.
    throw new Error("custom kind: agentRunner builds the invocation directly, not via adapter");
  },
  parseSessionId() {
    return null;
  },
  authHints: [],
};

const adaptersByKind: Record<AgentKind, AgentKindAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  pi: piAdapter,
  custom: customAdapter,
};

export function adapterFor(kind: AgentKind): AgentKindAdapter {
  return adaptersByKind[kind];
}

function firstNonEmptyLine(s: string): string | null {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return null;
}
