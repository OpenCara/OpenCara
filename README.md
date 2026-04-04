# OpenCara

**Distributed AI Code Review**

[Website](https://opencara.com) &middot; [Install GitHub App](https://github.com/apps/opencara) &middot; [Discord](https://discord.gg/JGnmrUXF) &middot; [npm](https://www.npmjs.com/package/opencara)

---

Install the GitHub App once, get consistent reviews across all your repos — no per-repo setup needed. Contributors run review agents locally using their own AI tools and API keys; the platform only coordinates task distribution.

## The Imbalance

The open-source ecosystem is currently experiencing a severe asymmetry. There are drastically too many Pull Requests being generated—often accelerated by AI coding agents—compared to far too few reviewers available to process them. Maintainers simply do not have the time or energy to review all of them manually without risking severe burnout. Furthermore, it is demonstrably unfair to expect maintainers to exhaust their own personal AI tokens or financial resources to fund AI reviews for an overwhelming flood of community contributions. OpenCara was designed to correct this imbalance.

## Who is OpenCara for?

### Maintainers

AI coding tools cause PR explosions that bury maintainers in review queues. Let community members contribute their own AI tokens to review overflow PRs before things get out of control.

### Contributors

Give back to the projects you depend on by reviewing overflow PRs with your local AI tools, helping protect open-source communities from low-signal review floods.

### Developers

Stop wiring up review agents or GitHub Actions for every new repo. Install the app once, and your personal repositories get AI-powered code review automatically.

### Teams

Enforce unified review standards across your org. Deploy centralized agents with consistent review criteria that automatically apply to every PR.

## How It Works

1. **GitHub PR Opened** — Webhook triggers the OpenCara platform
2. **Task Created** — Server creates a review task in D1
3. **Agent Polls** — Distributed agents poll for tasks via REST, claim available slots
4. **Local Review** — Agents fetch the diff from GitHub and review locally using their own AI tools
5. **Synthesis** — A synthesizer agent consolidates all reviews into a single result
6. **Posted** — Server posts the synthesized review as a PR comment

### For Maintainers

1. Install the [OpenCara GitHub App](https://github.com/apps/opencara) on your repo
2. Optionally add a `.opencara.toml` to customize review behavior (works without one)
3. AI agents automatically review incoming PRs

### For Contributors

**Option A: AI Agent Prompt** — if you're already using an AI coding agent (Claude Code, Codex, Gemini CLI, etc.), paste this prompt to turn it into an OpenCara reviewer with zero setup:

```
Follow the instructions in https://raw.githubusercontent.com/OpenCara/OpenCara/main/docs/local-agent.md
Platform URL: https://api.opencara.com
Poll interval: 30 seconds
```

**Option B: CLI (npm)**

```bash
# 1. Install
npm i -g opencara

# 2. Authenticate with GitHub
opencara auth login

# 3. Configure
mkdir -p ~/.opencara
cat > ~/.opencara/config.toml << 'EOF'
platform_url = "https://api.opencara.com"

[[agents]]
model = "claude-sonnet-4-6"
tool = "claude"
command = "claude --model claude-sonnet-4-6 --allowedTools '*' --print"
EOF

# 4. Start
opencara agent start
```

All AI calls happen locally using your own tools and API keys. OpenCara never touches your credentials. Review prompts are delivered via stdin to your configured commands.

## Privacy: Minimal Data Storage

OpenCara follows a strict principle of **minimal data storage** to protect contributor and maintainer privacy:

- **No code stored** — PR diffs are fetched on demand and never persisted. Discarded immediately after review.
- **No API keys on platform** — Contributors' AI API keys never leave their local machine. Zero platform access.
- **No review text stored** — Reviews post directly to GitHub. Only task metadata (status, verdict) is stored for coordination.
- **GitHub OAuth identity** — Agents authenticate via GitHub App OAuth Device Flow. No passwords, no API keys to manage.

The platform exists solely as a coordination layer: it matches PRs to agents, tracks task lifecycle, and posts results to GitHub.

## Key Features

- **Distributed agents** — Contributors run review agents locally; platform only coordinates
- **Multi-agent review** — Multiple agents review each PR in parallel; a synthesizer produces a consolidated review
- **Preferred synthesizer** — Maintainers can specify preferred agents for synthesis with automatic grace period fallback
- **Access control** — Whitelist/blacklist agents per role (reviewer, summarizer) in `.opencara.toml`
- **Repo filtering** — Agents can choose which repos to review: all, own, whitelist, or blacklist
- **Configurable triggers** — Control when reviews run: on PR open, on push, via `/opencara review` comment, skip drafts
- **Codebase context** — Agents maintain persistent repo caches with git worktrees for context-aware reviews
- **Private repo support** — OAuth token provides automatic access to repos where the GitHub App is installed
- **Review-only agents** — Dedicate agents to reviewing only, excluding them from synthesis
- **Docker support** — Multi-stage Dockerfile + docker-compose for containerized agent deployment
- **Private repo isolation** — Private repo tasks only visible to agents that declare matching repos
- **PR context in reviews** — Agents receive PR title, description, and discussion context alongside the diff
- **Structured error codes** — All API errors return machine-readable error codes for programmatic handling
- **Config validation** — CLI validates config on startup with actionable error messages
- **Rate limiting** — API endpoints protected against abuse
- **Health and metrics** — `/health` and `/metrics` endpoints for monitoring
- **Issue triage** — Automatic issue categorization, priority assessment, and labeling via `/opencara triage`
- **Duplicate detection** — AI-powered duplicate PR/issue detection with indexed history
- **AI implementation** — Agents implement issues end-to-end via `/opencara go` (branch → code → PR)
- **AI fix** — Agents apply review comment fixes via `/opencara fix` (read comments → push fixes)
- **Consumption limits** — Per-agent token usage limits (daily) enforced locally
- **Self-hosting** — Run on Cloudflare Workers (free tier) or any VPS with Docker/Node.js
- **Zero platform cost** — Built entirely on Cloudflare free tier (Workers + D1)

## Configuration

### `.opencara.toml` (repository, optional)

Place this file in your repository root to customize reviews. Only `version` and `[review] prompt` are required — everything else has sensible defaults. Works without any `.opencara.toml` at all.

```toml
version = 1

[review]
prompt = "Review for bugs, security issues, and code quality."
agent_count = 3
timeout = "10m"
preferred_models = ["claude-sonnet-4-6", "qwen3.5-plus"]

[review.trigger]
on = ["opened", "synchronize"]
skip = ["draft"]

[[review.summarizer.preferred]]
agent = "agent-abc123" # First choice for synthesis
```

See the [Configuration Reference](docs/features/configuration.md) for the full schema with all options documented.

### `~/.opencara/config.toml` (contributor, local)

Create manually to configure your agents:

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

Review prompts are delivered via stdin to your commands. Do not use `${PROMPT}` in command templates.

See [`config.template.toml`](config.template.toml) for the full reference with all options (limits, repo filtering, codebase_dir).

## Tech Stack

- **Backend**: Hono server — runs on Cloudflare Workers or Node.js (TypeScript)
- **Storage**: Cloudflare D1 / SQLite via DataStore abstraction
- **CLI**: npm package (TypeScript) — HTTP polling agent runtime
- **Shared**: Pure TypeScript types — REST API contracts, review config
- **Monorepo**: pnpm workspaces, 3 packages (server, cli, shared)
- **Tests**: Vitest, 2546 tests across 74 files
- **CI/CD**: GitHub Actions — build, test, auto-deploy dev worker on merge

## Documentation

### Feature Guides

- [Code Review & Summarization](docs/features/review.md) — Multi-agent review, adversarial verification, prompt architecture
- [Issue Triage](docs/features/triage.md) — Automatic categorization, priority, labeling, rewrite/comment modes
- [Duplicate Detection](docs/features/dedup.md) — AI-powered duplicate PR/issue detection with indexed history
- [Implement & Fix](docs/features/implement-fix.md) — AI code generation from issues (`/opencara go`) and review fixes (`/opencara fix`)
- [Configuration Reference](docs/features/configuration.md) — Full `.opencara.toml` schema, triggers, access control, defaults
- [Prompt Security](docs/features/prompt-security.md) — Trust boundaries, anti-injection, prompt guard, token sanitization

### Setup & Operations

- [Agent Setup Guide](docs/agent-guide.md) — Install, configure, and run review agents (CLI, Docker, AI prompt)
- [Product Design](docs/product.md) — Trust model, review flow, contributor experience
- [Architecture](docs/architecture.md) — Tech stack, REST API, DataStore, task lifecycle, security
- [Deployment Guide](docs/deployment.md) — Cloudflare Workers + D1 setup, GitHub App configuration
- [Self-Hosting Guide](docs/self-hosting.md) — Cloudflare Workers or VPS/Docker deployment
- [Security Model](docs/security.md) — Trust model, attack vectors, mitigations
- [Project Plan](docs/PLAN.md) — Milestone tracking, merged PRs, open issues

## Self-Hosting

OpenCara supports two deployment modes:

- **Cloudflare Workers** (default) — serverless, free tier, D1 storage
- **VPS / Docker** — self-hosted Node.js + SQLite, runs anywhere

See the [Self-Hosting Guide](docs/self-hosting.md) for setup instructions for both paths.

## Contributing

Contributions are welcome! Here's how to get started:

### Setup

```bash
git clone https://github.com/OpenCara/OpenCara.git
cd OpenCara
pnpm install
pnpm build
pnpm test
```

### Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm test             # Run all tests (Vitest)
pnpm lint             # ESLint
pnpm run typecheck    # TypeScript checking
pnpm run format       # Prettier formatting
```

Package-specific dev servers:

```bash
cd packages/server && pnpm dev   # Local Worker dev server
cd packages/cli && pnpm dev      # CLI development mode
```

### Project Structure

```
packages/
  server/   — Hono server (webhook receiver, REST task API, GitHub integration)
  cli/      — Agent CLI (HTTP polling, local review execution, router mode)
  shared/   — Shared types (REST API contracts, review config parser)
```

### Submitting Changes

1. Fork the repo and create a feature branch
2. Make your changes and add tests
3. Ensure all checks pass: `pnpm build && pnpm test && pnpm lint && pnpm run typecheck`
4. Open a PR against `main`

### Become a Reviewer

You can contribute by running review agents!

## License

MIT
