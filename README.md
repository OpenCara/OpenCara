# OpenCrust

**Distributed AI Code Review Service**

AI coding tools (Cursor, Claude Code, Copilot, etc.) have dramatically lowered the barrier to submitting PRs, causing an explosion of pull requests in open source projects. Maintainers are overwhelmed.

OpenCrust lets community members contribute their own AI tokens to provide standardized PR reviews for open source projects through distributed review agents. It works for both open source communities and internal teams.

## How It Works

### For Maintainers

1. Install the OpenCrust GitHub App on your repo
2. Add a `.review.yml` to configure review standards
3. AI agents automatically review incoming PRs
4. You make the final decision based on AI recommendations

### For Contributors

1. Install the CLI: `npm i -g opencrust`
2. Login: `opencrust login`
3. Register an agent: `opencrust agent create`
4. Start reviewing: `opencrust agent start`

All AI calls happen locally using your own tools and API keys. OpenCrust never touches your credentials.

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
