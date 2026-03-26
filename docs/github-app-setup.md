# GitHub App Setup

This document describes how to create and configure the GitHub App for OpenCara.

## Create a GitHub App

1. Go to **GitHub Settings > Developer settings > GitHub Apps > New GitHub App**
2. Fill in the following:
   - **GitHub App name**: `OpenCara` (or your preferred name)
   - **Homepage URL**: Your OpenCara dashboard URL
   - **Webhook URL**: `https://<worker-domain>/webhook/github`
   - **Webhook secret**: Generate a strong random secret (save this for later)

## Required Permissions

Configure these **Repository permissions**:

| Permission    | Access       | Purpose                          |
| ------------- | ------------ | -------------------------------- |
| Pull requests | Read & Write | Read PR details, post comments   |
| Issues        | Read         | Read issue context               |
| Contents      | Read         | Read `.opencara.toml` from repos |

No **Organization permissions** or **Account permissions** are needed.

## Subscribe to Events

Enable these webhook events:

- **Pull request** — triggers review when PRs are opened or updated
- **Issue comment** — enables `/opencara review` manual trigger on PRs
- **Installation** — tracks when the app is installed/uninstalled on repos

## Post-Creation Setup

After creating the app, note down:

- **App ID** — shown on the app settings page
- **Client ID** — shown on the app settings page
- **Private key** — generate and download from the app settings page

## Configure Worker Secrets

Set these secrets on your Cloudflare Worker using `wrangler secret put`:

```bash
cd packages/server

# The webhook secret you set during app creation
wrangler secret put GITHUB_WEBHOOK_SECRET

# The App ID from the app settings page
wrangler secret put GITHUB_APP_ID

# The private key PEM content (paste the full PEM including headers)
wrangler secret put GITHUB_APP_PRIVATE_KEY
```

## Install the App

1. Go to the app's public page: `https://github.com/apps/<app-name>`
2. Click **Install**
3. Choose which repositories to grant access to
4. The app will start receiving webhook events for those repositories

## OAuth Device Flow Setup

The GitHub App supports OAuth Device Flow for CLI agent authentication. This replaces manual GitHub tokens — agents authenticate via `opencara auth login` and get a single token for both platform auth and GitHub API access.

### Enable Device Flow

1. Go to the GitHub App settings page
2. Under **General**, check **"Enable Device Flow"**
3. Save changes

### Generate Client Secret

1. On the same settings page, under **Client secrets**, click **Generate a new client secret**
2. Copy the secret immediately (it's shown only once)

### Set Worker Secrets

Add the Client ID and Client Secret to your Cloudflare Worker:

```bash
cd packages/server

# Dev environment
wrangler secret put GITHUB_CLIENT_ID --env dev
wrangler secret put GITHUB_CLIENT_SECRET --env dev

# Production
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
```

The Client ID is shown on the GitHub App settings page (the `Iv1.xxx...` value).

### Enable OAuth Enforcement (optional)

By default, the server accepts both OAuth tokens and API keys. To require OAuth for all task endpoints:

Add to `wrangler.toml` under `[vars]`:

```toml
OAUTH_REQUIRED = "true"
```

When `OAUTH_REQUIRED=true`, agents must authenticate via `opencara auth login`. API key auth is rejected on task endpoints.

### How OAuth Works

```
CLI: opencara auth login
  → POST /api/auth/device        (server proxies to GitHub, adds client_id)
  → User opens browser URL, enters code
  → POST /api/auth/device/token  (server proxies to GitHub, adds client_id + client_secret)
  ← GitHub returns access_token + refresh_token
  → CLI stores tokens in ~/.opencara/auth.json

Agent polling:
  → Authorization: Bearer ghu_xxx  (OAuth token in all API requests)
  → Server verifies token via GitHub API, caches SHA-256(token) in D1 (1hr TTL)
  → Server extracts github_user_id and github_username from verified token
  → Identity is trusted — no self-reported fields needed
```

### Token Lifecycle

| Token         | Lifetime | Refresh                                             |
| ------------- | -------- | --------------------------------------------------- |
| Access token  | 8 hours  | CLI auto-refreshes with 5-minute buffer             |
| Refresh token | 6 months | User must run `opencara auth login` when it expires |

### Permissions

The OAuth token inherits the app's installation permissions:

- **Contents: Read** — fetch PR diffs from private repos
- **Pull requests: Read & Write** — post review comments
- **Issues: Read** — read issue context

Access is scoped to repos where the app is installed AND the user has personal access.

## How It Works

1. When a PR is opened or updated, GitHub sends a webhook to the Worker
2. The Worker validates the webhook signature using `GITHUB_WEBHOOK_SECRET`
3. The Worker generates an installation access token using the App's private key
4. The Worker reads `.opencara.toml` from the repository to determine review configuration
5. If `.opencara.toml` exists and is valid, the server creates a review task in D1
6. Agents poll for tasks, claim them, execute reviews, and submit results
7. The server posts the final review to the PR using the installation token
