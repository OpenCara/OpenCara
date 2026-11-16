# Deploying the OpenCara server

The server is released as a versioned Docker image and rolled out to the
opencara.com host on every `v<semver>` git tag by the deploy workflow.

```
git tag v1.0.2 && git push origin v1.0.2
```

The workflow lives at
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

That single tag push triggers two independent workflows:

| Workflow          | Ships                                   |
| ----------------- | --------------------------------------- |
| `publish-cli.yml` | the `opencara` CLI to npm               |
| `deploy.yml`      | the server image to GHCR + opencara.com |

## What the deploy workflow does

1. **Verify** the tagged commit is reachable from `main` (a feature-branch tag
   never deploys).
2. **Build** the image from the root [`Dockerfile`](../Dockerfile) — web SPA +
   orchestrator — and **push** it to GHCR as
   `ghcr.io/opencara/opencara/server:v1.0.2` and `:latest`
   (`:latest` is skipped for prereleases like `v1.0.2-rc.1`).
3. **Deploy** over [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh):
   the runner joins the tailnet as an ephemeral `tag:ci` node, copies
   [`docker-compose.prod.yml`](./docker-compose.prod.yml)
   and [`deploy.sh`](./deploy.sh) to the host, pull the new tag, and
   `docker compose up -d --wait` it.
4. **Gate on health**: the run only goes green once the container reports
   healthy (`GET /health`) and the endpoint actually answers. Any failure in
   build, push, or deploy exits non-zero and fails the run.

The image runs `node dist/index.js`, which applies Drizzle migrations on boot
before serving — so a release that includes a migration self-applies it, and a
failing migration fails the deploy instead of half-applying.

## Required GitHub Actions secrets

Set these under **Settings → Secrets and variables → Actions** (and gate the
`production` environment with required reviewers if you want a manual approval
before any rollout):

| Secret             | Purpose                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (scope: `auth_keys` write, tag `tag:ci`) |
| `TS_OAUTH_SECRET`  | Tailscale OAuth client secret                                       |
| `DEPLOY_SSH_HOST`  | Tailnet name of the opencara.com server (MagicDNS, e.g. `nerd`)     |
| `DEPLOY_SSH_USER`  | Host user (must be able to run `docker`)                            |
| `GHCR_PULL_TOKEN`  | PAT with `read:packages` so the host can pull from GHCR. Omit if the GHCR package is public. |

Pushing the image uses the built-in `GITHUB_TOKEN` (`packages: write`) — no
secret needed for that half.

There is no SSH key: Tailscale SSH authenticates by tailnet identity. The
tailnet policy must own `tag:ci`, let it reach the host, and **accept** (not
`check` — CI can't complete a browser re-auth) SSH into it:

```jsonc
"tagOwners": { "tag:ci": ["autogroup:admin"], "tag:server": ["autogroup:admin"] },
"grants":    [{ "src": ["tag:ci"], "dst": ["tag:server"], "ip": ["tcp:22"] }],
"ssh":       [{ "action": "accept", "src": ["tag:ci"], "dst": ["tag:server"], "users": ["quabug"] }]
```

## One-time host setup

On the deploy host:

1. Install Docker Engine + the Compose plugin; ensure `DEPLOY_SSH_USER` can run
   `docker` without sudo. Join the tailnet with Tailscale SSH enabled and the
   host tag: `sudo tailscale up --ssh --advertise-tags=tag:server`. No public
   `sshd` is needed.
2. Create the deploy directory and the production env file (the workflow ships
   the compose file and script, but **never** secrets):

   ```bash
   sudo mkdir -p /opt/opencara
   sudo chown "$USER" /opt/opencara
   # Fill in real values — same keys as .env.example, production targets:
   #   PORT, PUBLIC_BASE_URL, DATABASE_URL,
   #   GITHUB_APP_ID, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET,
   #   GITHUB_APP_PRIVATE_KEY (PEM contents, not a path),
   #   GITHUB_WEBHOOK_SECRET, SESSION_ENCRYPTION_KEY, SESSION_COOKIE_NAME, ...
   $EDITOR /opt/opencara/.env.production
   chmod 600 /opt/opencara/.env.production
   ```

   Use `GITHUB_APP_PRIVATE_KEY` (the PEM contents) rather than
   `GITHUB_APP_PRIVATE_KEY_PATH` so no key file has to live on the host.

3. Point the Cloudflare tunnel (or whatever fronts opencara.com) at
   `localhost:3030` — the container binds `127.0.0.1:3030` only.

> **Cutover from the bare-metal `nohup` process:** the old
> [`scripts/deploy.sh`](../scripts/deploy.sh) ran the orchestrator directly on
> `:3030`. Stop that process before the first container deploy so they don't
> fight over the port. From then on `restart: unless-stopped` gives the
> supervisor the bare process never had.

## Local PostgreSQL

`docker-compose.prod.yml` includes a `db` service (postgres:17-alpine, named
volume `opencara_pgdata`, `shared_preload_libraries=pg_stat_statements`). The
server connects over the internal compose network at `db:5432`; the only host
port is a loopback `127.0.0.1:5433` for `pg_dump` backups and ad-hoc `psql`.

Its credentials live in **`/opt/opencara/.env`** (Compose's interpolation
file — `env_file` vars are NOT visible to `${VAR}` expansion):

```bash
POSTGRES_USER=opencara
POSTGRES_PASSWORD=<generated>
POSTGRES_DB=opencara
```

and the app's `.env.production` points at it:
`DATABASE_URL=postgres://opencara:<same-password>@db:5432/opencara`.

`DATA_RETENTION_DAYS` (default `7`, `0` disables) controls the on-boot + daily
prune of terminal `agent_runs`/`flow_runs`, unreferenced `platform_events`, and
expired `sessions` (batched, FK-cascade safe). Set it in `.env.production`.

## Rollback

Every release is an immutable GHCR tag, so rolling back is redeploying a prior
one — **no rebuild, no CI**. Two equivalent ways:

**A. From GitHub (preferred):** Actions → **deploy** → *Run workflow* → set
`image_tag` to the known-good version (e.g. `v1.0.1`). This re-runs only the
deploy job against the existing image.

**B. On the host directly:**

```bash
cd /opt/opencara
OPENCARA_IMAGE_TAG=v1.0.1 ./deploy.sh
```

Either way `deploy.sh` pulls that tag, swaps the container, and gates on health
before returning success — so a bad rollback target fails loudly too.

To see which tags are available to roll back to, list them in GHCR (repo →
Packages → `server`) or check pushed git tags with `git tag --list 'v*'`.
