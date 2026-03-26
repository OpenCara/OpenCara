# Deployment Guide

Step-by-step instructions for deploying OpenCara.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) v9+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v4.74.0+ (`pnpm add -g wrangler`)
- A [Cloudflare](https://cloudflare.com/) account (free tier)
- A [GitHub](https://github.com/) account with permissions to create a GitHub App

## 1. GitHub App Setup

Follow the detailed instructions in [github-app-setup.md](github-app-setup.md).

Summary of what you need:

1. Create a GitHub App at **GitHub Settings > Developer settings > GitHub Apps**
2. Set the webhook URL to `https://<your-worker-domain>/webhook/github`
3. Generate a webhook secret (random string)
4. Configure permissions: Pull requests (Read & Write), Issues (Read), Contents (Read)
5. Subscribe to events: Pull request, Issue comment, Installation
6. Generate and download a private key

Note down these values:

| Value              | Where to find it                     |
| ------------------ | ------------------------------------ |
| **App ID**         | App settings page                    |
| **Private Key**    | Downloaded `.pem` file               |
| **Webhook Secret** | The secret you chose during creation |

## 2. Cloudflare Workers Setup

### 2.1 Authenticate Wrangler

```bash
wrangler login
```

### 2.2 Create a D1 Database

```bash
# Production
wrangler d1 create opencara-db
# Note the database_id — add it to wrangler.toml [[d1_databases]]

# Dev
wrangler d1 create opencara-db-dev
# Note the database_id — add it to wrangler.toml [[env.dev.d1_databases]]
```

Update `packages/server/wrangler.toml` with the D1 database IDs.

### 2.3 Set Secrets

```bash
cd packages/server

# GitHub App secrets
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY

# OAuth Device Flow secrets (for agent authentication)
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
```

> **Note**: For `GITHUB_APP_PRIVATE_KEY`, paste the full PEM content including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` headers.

For the dev environment, add `--env dev` to each command.

### 2.4 Configure Cron Trigger

The server uses a cron trigger (every minute) for timeout checking and task cleanup. This is configured in `packages/server/wrangler.toml`:

```toml
[triggers]
crons = ["* * * * *"]
```

No manual setup needed — the cron is included in the wrangler config and deployed automatically.

### 2.5 Deploy (Dev)

```bash
cd packages/server

# Dev environment
pnpm build
npx wrangler deploy --env dev
```

**Auto-deploy**: The dev worker is automatically deployed when code is merged to `main` via the `deploy-dev.yml` GitHub Actions workflow. No manual deployment needed for dev.

### 2.6 Deploy (Production)

Production uses Cloudflare Workers [Versions & Deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/) for safe releases with instant rollback. The prod worker (`opencara-server`) stays on a single domain — no blue/green or domain swapping.

#### Release Flow

1. **Upload a new version** (does not deploy):

   ```bash
   cd packages/server
   wrangler versions upload
   ```

   This creates a new version and outputs a version ID.

2. **Test before deploying** (optional):

   ```bash
   # Hit the prod URL with a version override header to route your request to the new version
   curl -H "Cloudflare-Workers-Version-Overrides: opencara-server=<version-id>" \
     https://api.opencara.com/api/meta
   ```

3. **Deploy the version**:

   ```bash
   # Instant 100% cutover
   wrangler versions deploy <version-id>@100%

   # Or gradual rollout (e.g., 10% canary)
   wrangler versions deploy <version-id>@10% <current-version-id>@90%
   ```

4. **Publish CLI** (if CLI changes are included):

   ```bash
   cd packages/cli
   npm version <version> --no-git-tag-version
   git tag v<version>
   git push origin v<version>   # Triggers publish-cli.yml
   ```

5. **Rollback** (if something goes wrong):
   ```bash
   cd packages/server
   wrangler rollback
   ```
   Rollback is instant and supports up to 100 previous versions.

#### Automated Release Script

Use `scripts/release.sh` for the full release workflow:

```bash
scripts/release.sh 0.16.0          # Full release: upload → deploy → tag → publish
scripts/release.sh 0.16.0 --test   # Upload + test instructions, pause before deploy
scripts/release.sh rollback        # Instant rollback to previous version
```

#### CI Workflow

The `publish-cli.yml` GitHub Actions workflow runs on version tags (`v*.*.*`):

1. Uploads a new worker version via `wrangler versions upload`
2. Deploys at 100% via `wrangler versions deploy`
3. Publishes the CLI to npm
4. Creates a GitHub release

### 2.7 Verify

```bash
# Health check
curl https://<your-worker-url>/health
# Expected: {"status":"ok","version":"..."}

# Server metadata and version info
curl https://<your-worker-url>/api/meta
# Expected: {"server_version":"0.16.0","min_cli_version":"0.15.0","features":[]}

# Metrics
curl https://<your-worker-url>/metrics
# Expected: {"tasks":{"pending":0,"reviewing":0,...}}

# Registry
curl https://<your-worker-url>/api/registry
# Expected: JSON with tools and models arrays
```

## 3. Post-Deployment

### 3.1 Update GitHub App Webhook URL

Set the webhook URL in your GitHub App settings:

```
https://<your-worker-url>/webhook/github
```

### 3.2 Install the GitHub App

1. Go to `https://github.com/apps/<your-app-name>`
2. Click **Install**
3. Choose which repositories to grant access

### 3.3 Verify End-to-End

1. Install the app on a test repository
2. Add a `.review.toml` file:
   ```toml
   version = 1
   prompt = "Review this PR for code quality and correctness."
   ```
3. Start an agent: `opencara agent start --all`
4. Open a PR — the server should create a task, the agent should review and post a PR comment

## D1 Migration Rules

Since both dev and prod share the same schema (and the prod worker may roll back to a previous version), all D1 migrations must follow these rules:

1. **Additive only** — never drop or rename columns in a single release
2. **Expand-contract pattern** for breaking schema changes:
   - Release N: add new column (old code ignores it)
   - Release N+1: backfill data, switch code to use new column
   - Release N+2: remove old column (optional)
3. **Server N must support CLI N-1** — old CLIs in the wild must continue working after a server upgrade

These rules ensure instant rollback is always safe and old CLIs degrade gracefully.

## Version Compatibility

The server enforces CLI version compatibility via the `X-OpenCara-CLI-Version` header:

- CLI sends its version in every API request
- Server returns `426 Upgrade Required` if the CLI version is below `MIN_CLI_VERSION`
- If the header is missing (old CLIs), the request is allowed for backward compatibility
- The `/api/meta` endpoint returns the current `server_version` and `min_cli_version`

Update `MIN_CLI_VERSION` in `packages/server/src/version.ts` when a server release introduces breaking API changes.

## Environment Variables Reference

### Cloudflare Worker Secrets

| Secret                   | Description                     | Source                 |
| ------------------------ | ------------------------------- | ---------------------- |
| `GITHUB_WEBHOOK_SECRET`  | Webhook signature verification  | GitHub App settings    |
| `GITHUB_APP_ID`          | GitHub App identifier           | GitHub App settings    |
| `GITHUB_APP_PRIVATE_KEY` | RSA private key (PEM format)    | Downloaded from GitHub |
| `GITHUB_CLIENT_ID`       | OAuth App Client ID (`Iv1.xxx`) | GitHub App settings    |
| `GITHUB_CLIENT_SECRET`   | OAuth App Client Secret         | GitHub App settings    |

### Wrangler Config Variables

| Variable         | Description                                    | In wrangler.toml   |
| ---------------- | ---------------------------------------------- | ------------------ |
| `WEB_URL`        | Frontend URL (for CORS, if needed)             | `[vars]` section   |
| `DB`             | D1 database binding                            | `[[d1_databases]]` |
| `OAUTH_REQUIRED` | Set to `"true"` to require OAuth on all agents | `[vars]` section   |

### CLI Environment Variables

| Variable                | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `OPENCARA_PLATFORM_URL` | Override `platform_url` from config (useful for switching environments) |
| `OPENCARA_CONFIG`       | Path to alternate config file (overrides `~/.opencara/config.toml`)     |

The CLI stores configuration locally at `~/.opencara/config.toml`. See [agent-guide.md](agent-guide.md) for details.

## Local Development

```bash
cd packages/server
pnpm dev    # starts wrangler dev with local D1 (SQLite)
```

**Wrangler 4.74.0+** is required for local D1 support. In local mode (`pnpm dev`), D1 runs as SQLite — no real Cloudflare resource IDs are needed. The `--remote` flag requires actual D1 database IDs configured in `wrangler.toml`.

## Troubleshooting

### Webhook not received

- Check the GitHub App webhook delivery log at **GitHub App Settings > Advanced > Recent Deliveries**
- Verify the webhook URL matches your Worker URL exactly (`https://<domain>/webhook/github`)
- Ensure the webhook secret matches `GITHUB_WEBHOOK_SECRET` in Wrangler

### Agent not receiving tasks

- Verify `platform_url` in `~/.opencara/config.toml` points to the correct Worker URL
- Check that the agent is polling (look for "polling every 10s" in logs)
- Verify a `.review.toml` exists in the target repo

### GitHub review not posted

- Check Worker logs (`wrangler tail --env dev`) for errors
- Verify `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are correct
- Ensure the GitHub App is installed on the target repo with correct permissions
