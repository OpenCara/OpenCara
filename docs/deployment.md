# Deployment Guide

Step-by-step instructions for deploying OpenCara.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) v9+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`pnpm add -g wrangler`)
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

### 2.2 Create a KV Namespace

```bash
# Production
wrangler kv namespace create TASK_STORE
# Note the ID — add it to wrangler.toml

# Dev
wrangler kv namespace create TASK_STORE --env dev
# Note the ID — add it to wrangler.toml [env.dev] section
```

Update `packages/server/wrangler.toml` with the KV namespace IDs.

### 2.3 Set Secrets

```bash
cd packages/server

# GitHub App secrets
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
```

> **Note**: For `GITHUB_APP_PRIVATE_KEY`, paste the full PEM content including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` headers.

For the dev environment, add `--env dev` to each command.

### 2.4 Deploy

```bash
cd packages/server

# Dev environment
pnpm build
npx wrangler deploy --env dev

# Production (team lead only)
npx wrangler deploy
```

### 2.5 Verify

```bash
# Health check
curl https://<your-worker-url>/
# Expected: {"status":"ok","service":"opencara-server"}

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
2. Add a `.review.yml` file:
   ```yaml
   version: 1
   prompt: 'Review this PR for code quality and correctness.'
   ```
3. Start an agent: `opencara agent start --all`
4. Open a PR — the server should create a task, the agent should review and post a comment

## Environment Variables Reference

### Cloudflare Worker Secrets

| Secret                   | Description                    | Source                 |
| ------------------------ | ------------------------------ | ---------------------- |
| `GITHUB_WEBHOOK_SECRET`  | Webhook signature verification | GitHub App settings    |
| `GITHUB_APP_ID`          | GitHub App identifier          | GitHub App settings    |
| `GITHUB_APP_PRIVATE_KEY` | RSA private key (PEM format)   | Downloaded from GitHub |

### Wrangler Config Variables

| Variable     | Description                        | In wrangler.toml    |
| ------------ | ---------------------------------- | ------------------- |
| `WEB_URL`    | Frontend URL (for CORS, if needed) | `[vars]` section    |
| `TASK_STORE` | KV namespace binding               | `[[kv_namespaces]]` |

### CLI Configuration

The CLI stores configuration locally at `~/.opencara/config.yml`. See [agent-guide.md](agent-guide.md) for details.

## Troubleshooting

### Webhook not received

- Check the GitHub App webhook delivery log at **GitHub App Settings > Advanced > Recent Deliveries**
- Verify the webhook URL matches your Worker URL exactly (`https://<domain>/webhook/github`)
- Ensure the webhook secret matches `GITHUB_WEBHOOK_SECRET` in Wrangler

### Agent not receiving tasks

- Verify `platform_url` in `~/.opencara/config.yml` points to the correct Worker URL
- Check that the agent is polling (look for "polling every 10s" in logs)
- Verify a `.review.yml` exists in the target repo

### GitHub review not posted

- Check Worker logs (`wrangler tail --env dev`) for errors
- Verify `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are correct
- Ensure the GitHub App is installed on the target repo with correct permissions
