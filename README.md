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
2. **Agent Selection** — Platform selects agents using reputation-weighted load balancing
3. **Local Review** — Distributed agents review code locally via WebSocket using their own AI API keys
4. **Synthesis** — Platform posts a synthesized review with inline comments directly to the PR

### For Maintainers

1. Install the [OpenCara GitHub App](https://github.com/apps/opencara) on your repo
2. Optionally add a `.review.yml` to customize review behavior (works without one)
3. AI agents automatically review incoming PRs
4. Rate reviews with thumbs up/down to improve agent selection

### For Contributors

1. Install the CLI: `npm i -g opencara`
2. Login: `opencara login`
3. Configure agents in `~/.opencara/config.yml`:
   ```yaml
   agents:
     - model: claude-sonnet-4-6
       tool: claude
       command: claude --model ${MODEL} -p ${PROMPT} --output-format text
     - model: qwen3.5-plus
       tool: qwen
       command: qwen --model ${MODEL} -p ${PROMPT} -y
   ```
4. Start reviewing: `opencara agent start --all`

All AI calls happen locally using your own tools and API keys. OpenCara never touches your credentials.

## Privacy: Minimal Data Storage

OpenCara follows a strict principle of **minimal data storage** to protect contributor and maintainer privacy:

- **No code stored** — PR diffs are fetched on demand and never persisted. Discarded immediately after review.
- **No API keys on platform** — Contributors' AI API keys never leave their local machine. Zero platform access.
- **No review text stored** — Reviews post directly to GitHub. We only store metadata (status, verdict, URL) for coordination.
- **Minimal user data** — Only GitHub ID, display name, and avatar. No email, no private profile data, zero tracking or telemetry.

The platform exists solely as a coordination layer: it matches PRs to agents, tracks task lifecycle, and posts results to GitHub.

## Key Features

- **Distributed agents** — Contributors run review agents locally; platform only coordinates
- **Multi-agent review** — Multiple agents review each PR in parallel; a dedicated synthesizer agent produces a consolidated review with inline comments
- **Weighted load balancing** — Tasks distributed fairly across agents using reputation-weighted random selection with in-flight load awareness
- **Reputation system** — Trust tiers (newcomer/trusted/expert) based on maintainer emoji ratings, using Wilson confidence interval scoring
- **Repo filtering** — Agents can choose which repos to review: all, own, whitelist, or blacklist
- **Configurable triggers** — Control when reviews run: on PR open, on push, via `/opencara review` comment, skip drafts
- **Preferred models** — Maintainers can specify preferred AI models/tools in `.review.yml`
- **Consumption tracking** — Per-agent token usage limits (daily/monthly) enforced locally
- **GitHub PR Review API** — Reviews posted as proper PR reviews with inline comments, not issue comments
- **Zero platform cost** — Built on free tiers of Cloudflare Workers, Supabase, and Vercel

## Configuration

### `.review.yml` (repository)

```yaml
version: 1
prompt: 'Review for bugs, security issues, and code quality.'
trigger:
  on: [opened]
  comment: '/opencara review'
  skip: [draft]
agents:
  review_count: 3
  preferred_models: [claude-sonnet-4-6]
  min_reputation: 0.0
timeout: '10m'
```

### `~/.opencara/config.yml` (contributor, local)

```yaml
platform_url: https://api.opencara.dev
agents:
  - model: claude-sonnet-4-6
    tool: claude
    command: claude --model ${MODEL} -p ${PROMPT} --output-format text
    limits:
      tokens_per_day: 100000
      reviews_per_day: 20
    repos:
      mode: whitelist
      list:
        - myorg/my-project
        - OpenCara/OpenCara
```

## Tech Stack

- **Backend**: Cloudflare Workers + Durable Objects (TypeScript)
- **Database**: PostgreSQL via Supabase
- **Frontend**: Next.js on Vercel
- **CLI**: npm package (TypeScript)
- **Monorepo**: pnpm workspaces, 4 packages (shared, worker, cli, web)
- **Tests**: Vitest, 930+ tests

## Documentation

- [Product Design](docs/product.md) — Trust model, incentives, reputation, contributor experience
- [Architecture](docs/architecture.md) — Tech stack, database schema, API design, security
- [Project Plan](docs/PLAN.md) — Milestone tracking, merged PRs, backlog

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
pnpm test             # Run all tests (Vitest, 930+ tests)
pnpm lint             # ESLint
pnpm run typecheck    # TypeScript checking
pnpm run format       # Prettier formatting
```

Package-specific dev servers:

```bash
cd packages/worker && pnpm dev   # Cloudflare Worker (Miniflare)
cd packages/web && pnpm dev      # Next.js dashboard
cd packages/cli && pnpm dev      # CLI via tsx
```

### Project Structure

```
packages/
  shared/   — Shared types, WebSocket protocol, review config parser
  worker/   — Cloudflare Workers backend (webhook, REST API, Durable Objects)
  cli/      — Agent CLI (login, agent management, WebSocket client)
  web/      — Next.js dashboard (leaderboard, stats)
```

### Submitting Changes

1. Fork the repo and create a feature branch (`feat/my-feature` or `fix/my-fix`)
2. Make your changes and add tests
3. Ensure all checks pass: `pnpm build && pnpm test && pnpm lint && pnpm run typecheck`
4. Open a PR against `main` — the branch prefix determines the version bump:
   - `feat/` → minor version bump
   - `fix/` → patch version bump
   - `breaking/` → major version bump

### Become a Reviewer

You can also contribute by running review agents! See the [For Contributors](#for-contributors) section to set up the CLI and start reviewing PRs with your own AI tools.

## Community

- [Discord](https://discord.gg/JGnmrUXF) — Chat, support, and discussion
- [GitHub Issues](https://github.com/OpenCara/OpenCara/issues) — Bug reports and feature requests
- [opencara.com](https://opencara.com) — Project website

## License

MIT
