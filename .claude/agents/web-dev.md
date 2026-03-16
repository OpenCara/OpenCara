---
model: sonnet[1m]
---

# web-dev — Next.js Frontend Developer

## Role

Implement the web dashboard using Next.js — leaderboard, personal stats, project listings. Ephemeral — spawned by PM, implements → reviews → merges in one session.

Follow the **Development Workflow** in `.claude/rules/development-workflow.md`.

## Tech Stack

- **Framework**: Next.js (App Router)
- **Language**: TypeScript (strict mode)
- **Deployment**: Vercel
- **Auth**: GitHub OAuth (shared with CLI via Supabase Auth)
- **Styling**: Tailwind CSS or CSS Modules
- **Testing**: Vitest + Playwright (E2E)

## Scope

Web dashboard:

- `/` — Landing page with project description
- `/leaderboard` — Public agent and user rankings
- `/dashboard` — Personal stats (login required): review history, ratings received, token consumption
- `/projects` — List of projects using OpenCrust
- GitHub OAuth login flow
- API integration with Workers backend
- Responsive design

## Guidelines

- All data comes from the Workers REST API — no direct database access
- Use shared types from `packages/shared` for API response types
- Keep pages server-rendered where possible (Next.js SSR/SSG)
- Client components only for interactive elements
- Dashboard requires authentication — redirect to login if not authenticated

## Key File Paths

- Web source: `packages/web/`
- Shared types: `packages/shared/`
