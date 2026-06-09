# syntax=docker/dockerfile:1

###############################################################################
# OpenCara server image.
#
# Builds the web SPA + every workspace package, then runs the orchestrator —
# which serves the SPA static files, runs Drizzle migrations on boot, and
# listens on :3030 (the port the opencara.com Cloudflare tunnel points at).
#
# Published to GHCR by .github/workflows/deploy.yml on every `v*.*.*` tag.
# Debian-based (`-slim`, glibc) rather than Alpine on purpose: tailwind's
# @tailwindcss/oxide and rollup ship prebuilt glibc native binaries, and musl
# would force a from-source build (or silently fall back).
###############################################################################

ARG NODE_VERSION=24

# ---- builder: install all deps + compile every workspace -------------------
FROM node:${NODE_VERSION}-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack pins pnpm to the `packageManager` field in package.json, so the
# image build uses the exact same pnpm the lockfile was written with.
RUN corepack enable

WORKDIR /app

# Copy manifests first so the (slow) dependency-install layer is cached
# independently of source changes. Every workspace package.json must be listed
# here, or `pnpm install` can't resolve the workspace graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/flows/package.json packages/flows/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Source last: edits below this line don't bust the dependency layer.
COPY . .

# Builds web (tsc + vite) and every package (tsc -b) — the same `pnpm -r build`
# CI runs, so a green CI means this step won't surprise us at release time.
RUN pnpm -r build

# ---- runner: run the compiled orchestrator ---------------------------------
FROM node:${NODE_VERSION}-slim AS runner

ENV NODE_ENV=production
ENV PORT=3030

# curl powers the container HEALTHCHECK below (and the deploy script's gate).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the fully-built workspace wholesale. Keeping the monorepo layout intact
# is load-bearing at runtime:
#   * the orchestrator resolves @opencara/{shared,flows} via node_modules
#     symlinks into packages/*/dist
#   * static.ts serves the SPA from ../../../apps/web/dist
#   * index.ts applies migrations from ../drizzle
# (devDependencies ride along; correctness and a stable layout beat shaving
# image size for an internally-deployed server.)
COPY --from=builder /app ./

WORKDIR /app/packages/orchestrator

EXPOSE 3030

# Lets `docker compose up --wait` and `docker inspect` observe readiness.
# start-period covers install-free boot + the on-boot migration pass.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

# Production runs compiled JS (not tsx). Migrations run on boot; a failed
# migration exits non-zero, which the restart policy and the deploy health
# gate both surface as a failed release rather than a half-migrated site.
CMD ["node", "dist/index.js"]
