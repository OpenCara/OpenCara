# GitHub App Setup

This document describes how to create and configure the GitHub App for OpenCrust.

## Create a GitHub App

1. Go to **GitHub Settings > Developer settings > GitHub Apps > New GitHub App**
2. Fill in the following:
   - **GitHub App name**: `OpenCrust` (or your preferred name)
   - **Homepage URL**: Your OpenCrust dashboard URL
   - **Webhook URL**: `https://<worker-domain>/webhook/github`
   - **Webhook secret**: Generate a strong random secret (save this for later)

## Required Permissions

Configure these **Repository permissions**:

| Permission      | Access       | Purpose                        |
| --------------- | ------------ | ------------------------------ |
| Pull requests   | Read & Write | Read PR details, post comments |
| Issues          | Read         | Read issue context             |
| Contents        | Read         | Read `.review.yml` from repos  |

No **Organization permissions** or **Account permissions** are needed.

## Subscribe to Events

Enable these webhook events:

- **Pull request** — triggers review when PRs are opened or updated
- **Installation** — tracks when the app is installed/uninstalled on repos

## Post-Creation Setup

After creating the app, note down:

- **App ID** — shown on the app settings page
- **Client ID** — shown on the app settings page
- **Private key** — generate and download from the app settings page

## Configure Worker Secrets

Set these secrets on your Cloudflare Worker using `wrangler secret put`:

```bash
# The webhook secret you set during app creation
wrangler secret put GITHUB_WEBHOOK_SECRET

# The App ID from the app settings page
wrangler secret put GITHUB_APP_ID

# The private key PEM content (paste the full PEM including headers)
wrangler secret put GITHUB_APP_PRIVATE_KEY

# The Client ID from the app settings page
wrangler secret put GITHUB_CLIENT_ID
```

## Install the App

1. Go to the app's public page: `https://github.com/apps/<app-name>`
2. Click **Install**
3. Choose which repositories to grant access to
4. The app will start receiving webhook events for those repositories

## How It Works

1. When a PR is opened or updated, GitHub sends a webhook to the Worker
2. The Worker validates the webhook signature using `GITHUB_WEBHOOK_SECRET`
3. The Worker generates an installation access token using the App's private key
4. The Worker reads `.review.yml` from the repository to determine review configuration
5. If `.review.yml` exists and is valid, the Worker creates a review task (M4+)
6. Review results are posted back as PR comments using the installation token
