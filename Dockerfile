# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY packages/shared/ packages/shared/
COPY packages/cli/ packages/cli/
RUN pnpm --filter opencara... build

# Stage 2: Runtime
FROM node:20-slim
WORKDIR /app
RUN corepack enable
COPY --from=builder /app/packages/cli/dist packages/cli/dist
COPY --from=builder /app/packages/cli/package.json packages/cli/
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod
ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["agent", "start"]
