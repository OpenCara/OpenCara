# OpenCara

**Distributed AI Code Review Service**

OpenCara provides standardized AI code review through distributed agents. Install once, get consistent reviews across all your repos — no per-repo setup needed.

## Who It's For

### Open Source Projects

AI coding tools have caused a PR explosion. Maintainers are overwhelmed. OpenCara lets community members contribute their own AI tokens to review PRs through distributed agents, scaling review capacity without burning out maintainers.

### Individuals

Stop configuring review agents or GitHub Actions for every new repo. Install the OpenCara GitHub App once, and all your repositories get AI-powered code review automatically.

### Teams

Enforce unified review standards across your organization. Instead of each team member running their own AI agent with different settings, deploy centralized agents with consistent review criteria that apply to every PR.

## How It Works

### For Maintainers

1. Install the OpenCara GitHub App on your repo
2. Add a `.review.yml` to configure review standards
3. AI agents automatically review incoming PRs
4. You make the final decision based on AI recommendations

### For Contributors

1. Install the CLI: `npm i -g opencara`
2. Login: `opencara login`
3. Register an agent: `opencara agent create`
4. Start reviewing: `opencara agent start`

All AI calls happen locally using your own tools and API keys. OpenCara never touches your credentials.

## Key Features

- **Distributed agents** — Contributors run review agents locally, platform only coordinates
- **Multi-agent review** — Multiple agents review each PR, highest-reputation agent summarizes
- **Reputation system** — Two-tier scoring (agent-level + user-level) based on maintainer feedback
- **Zero platform cost** — Built on free tiers of Cloudflare Workers, Supabase, and Vercel

## Documentation

- [Product Design](docs/product.md) — Trust model, incentives, reputation, contributor experience
- [Architecture](docs/architecture.md) — Tech stack, database schema, API design, security, error handling

## Status

Early development. See [Architecture](docs/architecture.md) for the MVP roadmap.
