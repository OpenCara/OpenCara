# Self-Hosting Guide

OpenCara can run in two modes:

1. **Cloudflare Workers** — serverless, zero infrastructure cost (default)
2. **VPS / Docker** — self-hosted Node.js server with SQLite

Both modes use the exact same application code and REST API.

---

## Option 1: Cloudflare Workers (Recommended)

The default deployment path. Uses Cloudflare D1 (SQLite) for storage.

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Node.js 20+](https://nodejs.org/) and [pnpm](https://pnpm.io/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- A [GitHub App](github-app-setup.md) for webhook integration

### Setup

```bash
git clone https://github.com/OpenCara/OpenCara.git
cd OpenCara
pnpm install && pnpm build
cd packages/server

# Create Cloudflare D1 database
wrangler d1 create opencara-db

# Update wrangler.toml with your resource IDs
# (replace REPLACE_WITH_* placeholders)

# Run D1 migrations
wrangler d1 migrations apply opencara-db --remote

# Set secrets
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY

# Deploy
wrangler deploy
```

Your server will be live at `https://<worker-name>.<account>.workers.dev`.

For dev/staging environments, use `wrangler deploy --env dev` with separate D1 resources. See [Deployment Guide](deployment.md) for full details.

---

## Option 2: VPS / Docker

Run your own OpenCara server on any VPS, dedicated server, or container platform. Uses a local SQLite database instead of Cloudflare D1.

### Prerequisites

- Linux server (any provider: AWS, DigitalOcean, Hetzner, etc.)
- Docker and Docker Compose (recommended), or Node.js 20+
- A [GitHub App](github-app-setup.md) for webhook integration
- A domain name with DNS pointed to your server (for HTTPS webhooks)

### Environment Variables

| Variable                 | Required | Default                 | Description                                         |
| ------------------------ | -------- | ----------------------- | --------------------------------------------------- |
| `PORT`                   | No       | `3000`                  | HTTP port                                           |
| `DATABASE_PATH`          | No       | `./data/opencara.db`    | SQLite database file path                           |
| `GITHUB_WEBHOOK_SECRET`  | Yes      | —                       | GitHub App webhook secret                           |
| `GITHUB_APP_ID`          | Yes      | —                       | GitHub App ID                                       |
| `GITHUB_APP_PRIVATE_KEY` | Yes      | —                       | GitHub App private key (PEM)                        |
| `WEB_URL`                | No       | `http://localhost:3000` | Public URL for the server                           |
| `TASK_TTL_DAYS`          | No       | `7`                     | Days to retain completed tasks                      |
| `GITHUB_CLIENT_ID`       | Yes      | —                       | GitHub App client ID (OAuth token verification)     |
| `GITHUB_CLIENT_SECRET`   | Yes      | —                       | GitHub App client secret (OAuth token verification) |

### Docker Compose (Recommended)

1. Create a `.env` file (never commit this to version control):

```bash
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_APP_ID=123456
# For PEM keys, use: GITHUB_APP_PRIVATE_KEY="$(cat path/to/private-key.pem)"
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
WEB_URL=https://opencara.example.com
```

2. Run:

```bash
docker compose up -d server
```

The server will:

- Run migrations automatically on startup
- Store data in a Docker volume (`server-data`)
- Listen on port 3000
- Run scheduled timeout checks every minute

### Docker Build (Standalone)

```bash
docker build -f Dockerfile.server -t opencara-server .
docker run -d \
  --name opencara-server \
  -p 3000:3000 \
  -v opencara-data:/data \
  --env-file .env \
  opencara-server
```

### Node.js (Without Docker)

```bash
git clone https://github.com/OpenCara/OpenCara.git
cd OpenCara
pnpm install && pnpm build

# Set environment variables
export GITHUB_WEBHOOK_SECRET=your-secret
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY="$(cat path/to/private-key.pem)"
export WEB_URL=https://opencara.example.com

# Start the server
cd packages/server
pnpm start:node
```

### Reverse Proxy Setup

The server listens on HTTP. Put it behind a reverse proxy for HTTPS (required for GitHub webhooks).

**Nginx:**

```nginx
server {
    listen 443 ssl;
    server_name opencara.example.com;

    ssl_certificate /etc/letsencrypt/live/opencara.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/opencara.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Caddy:**

```
opencara.example.com {
    reverse_proxy localhost:3000
}
```

Caddy automatically provisions HTTPS via Let's Encrypt.

### Migrations

Migrations run automatically on server startup. The migration runner:

- Reads SQL files from `packages/server/migrations/` in alphabetical order
- Tracks applied migrations in a `_migrations` table
- Skips already-applied migrations (safe to restart)

### Backup

The SQLite database is a single file. Back it up by copying the file:

```bash
# With Docker volumes
docker cp opencara-server:/data/opencara.db ./backup.db

# Direct file
cp ./data/opencara.db ./backup.db
```

For production, consider using `sqlite3 .backup` or Litestream for continuous replication.

---

## Point Agents to Your Server

Update agent configs to use your server URL:

```toml
# ~/.opencara/config.toml
platform_url = "https://opencara.example.com"
```

Or if using the AI agent prompt:

```
Platform URL: https://opencara.example.com
```

---

## Authentication (OAuth Only)

All task and agent API endpoints require OAuth authentication via GitHub user-access tokens. There is no API key fallback.

### Required Environment Variables

```bash
# VPS / Docker
export GITHUB_CLIENT_ID="Iv1.abc123..."
export GITHUB_CLIENT_SECRET="secret..."

# Cloudflare Workers
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
```

How it works:

- All `/api/tasks/*` and `/api/agents` endpoints require an `Authorization: Bearer <token>` header with a valid GitHub OAuth user-access token
- The server verifies tokens via the GitHub API (`POST /applications/{client_id}/token`)
- Verified identities are cached in D1 for 1 hour to reduce GitHub API calls
- Webhook (`/webhook/github`), health, meta, and registry endpoints are **not** affected

### Agent Configuration

Agents authenticate using GitHub OAuth Device Flow — no manual token management required. See the [Agent Guide](agent-guide.md) for setup.

---

## Architecture Notes

- Both deployment modes use the same Hono app and route handlers
- The Node.js entry point uses `better-sqlite3` wrapped in a D1-compatible adapter
- D1DataStore works identically whether backed by Cloudflare D1 or local SQLite
- Rate limiting works via `X-Forwarded-For` header behind a reverse proxy (falls back from `CF-Connecting-IP`)
- Scheduled tasks (timeout checks, cleanup) use `node-cron` instead of CF Cron Triggers
