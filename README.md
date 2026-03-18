# OpenCara

**Distributed AI Code Review Service**

OpenCara coordinates AI-powered code review through distributed agents. Install the GitHub App once, get consistent reviews across all your repos — no per-repo setup needed. Contributors run review agents locally using their own AI tools and API keys; the platform only coordinates task distribution.

## Who It's For

### Open Source Projects

AI coding tools have caused a PR explosion. Maintainers are overwhelmed. OpenCara lets community members contribute their own AI tokens to review PRs through distributed agents, scaling review capacity without burning out maintainers.

### Individuals

Stop configuring review agents or GitHub Actions for every new repo. Install the OpenCara GitHub App once, and all your repositories get AI-powered code review automatically.

### Teams

Enforce unified review standards across your organization. Instead of each team member running their own AI agent with different settings, deploy centralized agents with consistent review criteria that apply to every PR.

## How It Works

```
GitHub PR → Webhook → Platform (Cloudflare Workers)
  → Select agents (weighted random, load-balanced)
  → Distribute to connected agents via WebSocket
  → Agents review locally using their own AI tools
  → Platform posts synthesized review on the PR
```

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

- **No code stored** — PR diffs are fetched from GitHub on demand and never persisted in the database. Once a review is complete, the diff is discarded.
- **No API keys on platform** — Contributors' AI API keys never leave their local machine. The platform has zero access to any contributor credentials.
- **No review text stored server-side** — Review results are posted directly to GitHub. The platform stores only metadata (task status, verdict, comment URL) for coordination.
- **Minimal user data** — Only GitHub user ID, display name, and avatar URL are stored, sourced from GitHub OAuth. No email, no private profile data.
- **Agent preferences stay local** — The CLI config (`~/.opencara/config.yml`) with tool commands, API keys, and local limits lives only on the contributor's machine.
- **No telemetry** — The platform collects no usage analytics, no tracking, no behavioral data beyond what is needed for task coordination and reputation scoring.

The platform exists solely as a coordination layer: it matches PRs to agents, tracks task lifecycle, and posts results to GitHub. It does not need — and does not store — the actual content being reviewed.

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

## Supported AI Tools

| Tool               | Models                                       |
| ------------------ | -------------------------------------------- |
| Claude (Anthropic) | claude-opus-4-6, claude-sonnet-4-6           |
| Codex (OpenAI)     | gpt-5-codex                                  |
| Gemini (Google)    | gemini-2.5-pro                               |
| Qwen (Alibaba)     | qwen3.5-plus, glm-5, kimi-k2.5, minimax-m2.5 |

Custom tools can be configured via the `command` template in agent config.

## Configuration

### `.review.yml` (repository, optional)

Place this file in your repository root to customize reviews. Only `version` and `prompt` are required — everything else has sensible defaults. Works without any `.review.yml` at all.

```yaml
version: 1
prompt: 'Review for bugs, security issues, and code quality.'
trigger:
  on: [opened, synchronize]
  skip: [draft]
agents:
  review_count: 2
  preferred_models: [claude-sonnet-4-6, qwen3.5-plus]
timeout: '10m'
```

See [`.review.template.yml`](.review.template.yml) for the full reference with all options documented.

### `~/.opencara/config.yml` (contributor, local)

Created by `opencara login`. Add your agents and customize limits:

```yaml
platform_url: https://opencara-worker.opencara.workers.dev
agents:
  - model: claude-sonnet-4-6
    tool: claude
    command: claude --model ${MODEL} -p ${PROMPT} --output-format text
  - model: qwen3.5-plus
    tool: qwen
    command: qwen --model ${MODEL} -p ${PROMPT} -y
```

See [`config.template.yml`](config.template.yml) for the full reference with all options (limits, repo filtering, anonymous agents).

## Tech Stack

- **Backend**: Cloudflare Workers + Durable Objects (TypeScript)
- **Database**: PostgreSQL via Supabase
- **Frontend**: Next.js on Vercel
- **CLI**: npm package (TypeScript)
- **Monorepo**: pnpm workspaces, 4 packages (shared, worker, cli, web)
- **Tests**: Vitest, 890+ tests

## Documentation

- [Product Design](docs/product.md) — Trust model, incentives, reputation, contributor experience
- [Architecture](docs/architecture.md) — Tech stack, database schema, API design, security
- [Project Plan](docs/PLAN.md) — Milestone tracking, merged PRs, backlog

## Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm test             # Run all tests
pnpm lint             # ESLint
pnpm run typecheck    # TypeScript checking
pnpm run format       # Prettier formatting
```

## License

MIT

# test
