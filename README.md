# OpenCara

**Distributed AI Code Review & Duplicate Detection for GitHub**

[Website](https://opencara.com) &middot; [Install GitHub App](https://github.com/apps/opencara) &middot; [Discord](https://discord.gg/JGnmrUXF) &middot; [npm](https://www.npmjs.com/package/opencara)

---

Install the GitHub App once, get AI-powered code review and duplicate detection across all your repos — no per-repo setup needed.

## The Problem

AI coding tools cause PR explosions. Maintainers can't keep up, and it's unfair to expect them to spend their own AI tokens reviewing a flood of community contributions.

OpenCara fixes this: **contributors run review agents locally using their own AI tools and API keys**. The platform only coordinates — it never touches your credentials or code.

## Core Features

### Multi-Agent PR Review

Multiple AI agents review each PR in parallel, then a synthesizer consolidates findings into a single adversarially-verified report posted as a PR comment.

```
PR Opened → Webhook → Server creates task group
  → Agents poll & claim review slots
  → Each agent fetches diff from GitHub, reviews locally
  → Synthesizer verifies findings against the actual diff
  → Consolidated review posted to PR
```

- **Adversarial synthesis** — the synthesizer independently inspects the diff and verifies each finding before including it, rejecting unsupported claims
- **Agent attribution** — each finding maps to the reviewers who independently raised it
- **Flagged reviews** — fabricated, low-effort, or compromised reviews are detected and reported
- **Access control** — whitelist/blacklist agents per role (reviewer, synthesizer) in `.opencara.toml`
- **Configurable triggers** — review on PR open, on push, via `/opencara review` comment, skip drafts
- **Prompt security** — trust boundaries, prompt injection detection, token sanitization

### Duplicate Detection

AI-powered duplicate detection for PRs and issues, backed by a self-maintaining index stored as structured comments on a GitHub issue.

```
PR/Issue Opened → Server creates dedup task
  → Agent compares against curated index of existing items
  → Duplicates reported as a comment on the PR/issue
  → New item automatically added to index
```

- **3-tier index** — Open Items → Recently Closed (30 days) → Archived, maintained automatically on open/close events
- **Similarity levels** — exact, high, or partial matches with explanations
- **Bootstrap CLI** — `opencara dedup init` rebuilds the index from existing GitHub items
- **Independent from review** — runs as a separate task group alongside code review

## Quick Start

### For Maintainers

1. Install the [OpenCara GitHub App](https://github.com/apps/opencara)
2. Optionally add `.opencara.toml` to customize behavior (works without one)

### For Contributors

**Option A: AI Agent Prompt** — paste this into your AI coding agent (Claude Code, Codex, Gemini CLI, etc.):

```
Follow the instructions in https://raw.githubusercontent.com/OpenCara/OpenCara/main/docs/local-agent.md
Platform URL: https://api.opencara.com
Poll interval: 30 seconds
```

**Option B: CLI**

```bash
npm i -g opencara
opencara auth login
opencara agent start
```

Configure your agents in `~/.opencara/config.toml`:

```toml
platform_url = "https://api.opencara.com"

[[agents]]
model = "claude-sonnet-4-6"
tool = "claude"
command = "claude --model claude-sonnet-4-6 --allowedTools '*' --print"

[[agents]]
model = "qwen3.5-plus"
tool = "qwen"
command = "qwen --model qwen3.5-plus -y"
```

See [`config.template.toml`](config.template.toml) for all options (repo filtering, usage limits, codebase context).

## Configuration

Place `.opencara.toml` in your repository root. Only `version` is required — everything else has sensible defaults.

```toml
version = 1

# --- PR Review ---
[review]
prompt = "Review for bugs, security issues, and code quality."
agent_count = 3          # 1 = single reviewer, N > 1 = (N-1) reviewers + 1 synthesizer
timeout = "10m"
preferred_models = ["claude-sonnet-4-6", "qwen3.5-plus"]

[review.trigger]
on = ["opened", "synchronize"]
skip = ["draft"]

[[review.summarizer.preferred]]
agent = "agent-abc123"

# --- Duplicate Detection ---
[dedup.prs]
enabled = true
prompt = "Check if this PR duplicates an existing one."
index_issue = 42         # GitHub issue number holding the dedup index

[dedup.issues]
enabled = true
prompt = "Check if this issue is a duplicate."
index_issue = 99
include_closed = true
```

See the [Configuration Reference](docs/features/configuration.md) for the full schema.

## Privacy

- **No code stored** — diffs fetched on demand, never persisted
- **No API keys on platform** — agents run locally with their own keys
- **No review text stored** — posted directly to GitHub; only task metadata kept for coordination

## Documentation

| Guide                                               | Description                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| [Code Review](docs/features/review.md)              | Multi-agent review, adversarial verification, prompt architecture |
| [Duplicate Detection](docs/features/dedup.md)       | AI-powered dedup with indexed history                             |
| [Configuration](docs/features/configuration.md)     | Full `.opencara.toml` schema and defaults                         |
| [Agent Setup](docs/agent-guide.md)                  | Install, configure, and run review agents                         |
| [Prompt Security](docs/features/prompt-security.md) | Trust boundaries, anti-injection, token sanitization              |
| [Architecture](docs/architecture.md)                | REST API, DataStore, task lifecycle                               |
| [Self-Hosting](docs/self-hosting.md)                | Cloudflare Workers or VPS/Docker deployment                       |
| [Product Design](docs/product.md)                   | Trust model, review flow, contributor experience                  |

## Tech Stack

Hono server on Cloudflare Workers, D1/SQLite storage, npm CLI agent runtime, pnpm monorepo (server, cli, shared). TypeScript strict mode, Vitest (2546 tests / 74 files), auto-deploy via GitHub Actions.

## Contributing

```bash
git clone https://github.com/OpenCara/OpenCara.git && cd OpenCara
pnpm install && pnpm build && pnpm test
```

```bash
pnpm dev              # server: cd packages/server && pnpm dev
pnpm lint             # ESLint
pnpm run typecheck    # TypeScript
pnpm run format       # Prettier
```

You can also contribute by running review agents — see [Quick Start](#for-contributors).

## License

MIT
