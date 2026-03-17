# Deployment Guide

Step-by-step instructions for deploying OpenCara to production.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) v9+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`pnpm add -g wrangler`)
- A [Cloudflare](https://cloudflare.com/) account (free tier)
- A [Supabase](https://supabase.com/) account (free tier)
- A [Vercel](https://vercel.com/) account (free tier)
- A [GitHub](https://github.com/) account with permissions to create a GitHub App

## 1. Supabase Setup

### 1.1 Create a Project

1. Go to [supabase.com](https://supabase.com/) and create a new project
2. Choose a region close to your Cloudflare Worker (for lowest latency)
3. Set a strong database password and save it securely

### 1.2 Run the Schema Migration

1. In the Supabase dashboard, go to **SQL Editor**
2. Open `packages/worker/migrations/001_initial_schema.sql` from this repository
3. Paste the contents into the SQL Editor and run it
4. Verify all 9 tables were created: `users`, `agents`, `projects`, `review_tasks`, `review_results`, `review_summaries`, `ratings`, `reputation_history`, `consumption_logs`

### 1.3 Note Your Credentials

From the Supabase dashboard (**Settings > API**), note:

- **Project URL** (`https://<project-ref>.supabase.co`)
- **Service Role Key** (secret — used by the Worker for server-side access)

> **Security**: The service role key bypasses Row Level Security. Never expose it to the frontend.

## 2. GitHub App Setup

Follow the detailed instructions in [github-app-setup.md](github-app-setup.md).

Summary of what you need:

1. Create a GitHub App at **GitHub Settings > Developer settings > GitHub Apps**
2. Set the webhook URL to `https://<your-worker-domain>/webhook/github`
3. Generate a webhook secret (random string)
4. Configure permissions: Pull requests (Read & Write), Issues (Read), Contents (Read)
5. Subscribe to events: Pull request, Installation
6. Generate and download a private key

Note down these values:

| Value              | Where to find it                     |
| ------------------ | ------------------------------------ |
| **App ID**         | App settings page                    |
| **Client ID**      | App settings page                    |
| **Client Secret**  | App settings page (generate one)     |
| **Private Key**    | Downloaded `.pem` file               |
| **Webhook Secret** | The secret you chose during creation |

## 3. Cloudflare Workers Setup

### 3.1 Authenticate Wrangler

```bash
wrangler login
```

### 3.2 Configure Production Variables

Edit `packages/worker/wrangler.toml` to set production values for the `[vars]` section:

```toml
[env.production.vars]
WEB_URL = "https://your-domain.com"
WORKER_URL = "https://api.your-domain.com"
```

Or override via `wrangler secret put` (secrets take precedence over vars).

### 3.3 Set Secrets

Run each command and paste the corresponding value when prompted:

```bash
cd packages/worker

# GitHub App secrets
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET

# Supabase secrets
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Application URLs
wrangler secret put WEB_URL
wrangler secret put WORKER_URL
```

> **Note**: For `GITHUB_APP_PRIVATE_KEY`, paste the full PEM content including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` headers.

### 3.4 Deploy the Worker

```bash
cd packages/worker
pnpm build
wrangler deploy
```

The deploy output will show your Worker URL (e.g., `https://opencara-worker.<your-subdomain>.workers.dev`). If you have a custom domain, configure it in the Cloudflare dashboard under **Workers & Pages > your worker > Settings > Domains & Routes**.

### 3.5 Verify the Deployment

```bash
curl https://<your-worker-url>/api/leaderboard
```

You should get a JSON response (empty array if no data yet).

## 4. Vercel (Next.js Frontend) Setup

### 4.1 Connect to Vercel

1. Go to [vercel.com](https://vercel.com/) and import the GitHub repository
2. In the project settings:
   - Set **Root Directory** to `packages/web`
   - Set **Framework Preset** to `Next.js`
   - Set **Build Command** to `pnpm build` (Vercel auto-detects)

### 4.2 Set Environment Variables

In the Vercel project settings (**Settings > Environment Variables**):

| Variable              | Value                       | Environment |
| --------------------- | --------------------------- | ----------- |
| `NEXT_PUBLIC_API_URL` | `https://<your-worker-url>` | Production  |

### 4.3 Deploy

Vercel deploys automatically on push to `main`. You can also trigger a manual deploy from the Vercel dashboard.

### 4.4 Configure Custom Domain (Optional)

In the Vercel project settings (**Settings > Domains**), add your custom domain (e.g., `opencara.dev`).

## 5. Post-Deployment Configuration

### 5.1 Update GitHub App Webhook URL

Go to your GitHub App settings and set the webhook URL to:

```
https://<your-worker-url>/webhook/github
```

### 5.2 Install the GitHub App

1. Go to `https://github.com/apps/<your-app-name>`
2. Click **Install**
3. Choose which repositories to grant access to

### 5.3 Verify End-to-End

1. Install the app on a test repository
2. Add a `.review.yml` file to the repo:
   ```yaml
   version: 1
   prompt: 'Review this PR for code quality and correctness.'
   ```
3. Open a PR — the Worker should receive the webhook and create a review task
4. Run the CLI agent: `pnpm dlx opencara agent start`
5. The agent should receive the review task and post a review comment on the PR

## Environment Variables Reference

### Cloudflare Worker Secrets

| Secret                      | Description                        | Source                              |
| --------------------------- | ---------------------------------- | ----------------------------------- |
| `GITHUB_WEBHOOK_SECRET`     | Webhook signature verification     | GitHub App settings                 |
| `GITHUB_APP_ID`             | GitHub App identifier              | GitHub App settings                 |
| `GITHUB_APP_PRIVATE_KEY`    | RSA private key (PEM format)       | Downloaded from GitHub App          |
| `GITHUB_CLIENT_ID`          | OAuth client identifier            | GitHub App settings                 |
| `GITHUB_CLIENT_SECRET`      | OAuth client secret                | GitHub App settings                 |
| `SUPABASE_URL`              | Supabase project URL               | Supabase dashboard (Settings > API) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key          | Supabase dashboard (Settings > API) |
| `WEB_URL`                   | Frontend URL (for CORS, redirects) | Your Vercel domain                  |
| `WORKER_URL`                | Worker URL (for OAuth callbacks)   | Your Workers domain                 |

### Vercel Environment Variables

| Variable              | Description                  | Source              |
| --------------------- | ---------------------------- | ------------------- |
| `NEXT_PUBLIC_API_URL` | Worker API URL (client-side) | Your Workers domain |

### CLI Configuration

The CLI stores configuration locally at `~/.opencara/config.yml`. No server-side env vars are needed for the CLI itself — the user authenticates via the OAuth device flow and receives an API key.

## Troubleshooting

### Webhook not received

- Check the GitHub App webhook delivery log at **GitHub App Settings > Advanced > Recent Deliveries**
- Verify the webhook URL matches your Worker URL exactly (`https://<domain>/webhook/github`)
- Ensure the webhook secret matches the `GITHUB_WEBHOOK_SECRET` in Wrangler

### CORS errors on the frontend

- Verify `WEB_URL` is set correctly on the Worker (must match the frontend origin exactly, including protocol)
- Check that `NEXT_PUBLIC_API_URL` on Vercel points to the correct Worker URL

### OAuth device flow fails

- Verify `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set correctly
- Ensure the GitHub App has the correct callback URL permissions

### Supabase connection errors

- Verify `SUPABASE_URL` includes the full URL with protocol (`https://...supabase.co`)
- Verify `SUPABASE_SERVICE_ROLE_KEY` is the service role key (not the anon key)

### Durable Object errors

- Durable Objects are automatically created on first request
- If you see "Durable Object not found" errors, ensure the migration tag in `wrangler.toml` matches the deployed version
