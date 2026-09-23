# syntax=docker/dockerfile:1.7
FROM oven/bun:latest

WORKDIR /app

# Copy workspace packages first
COPY packages/shared ./packages/shared
COPY packages/contracts ./packages/contracts
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY package.json ./package.json
COPY bun.lock ./bun.lock
COPY .npmrc ./.npmrc

# Install dependencies. @vietz-dev/* comes from GitHub Packages, so the token is
# mounted as a build secret — it is never written to a layer (verify with
# `docker history`). Pass it with `--secret id=node_auth_token,env=NODE_AUTH_TOKEN`
# (docker compose wires this via the `node_auth_token` secret).
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token 2>/dev/null || true)" bun install

# Copy shared package and build
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
RUN cd packages/shared && bun run build

# Copy API source
COPY apps/api/src ./apps/api/src
COPY apps/api/prisma ./apps/api/prisma

# Generate Prisma client
RUN cd apps/api && bunx prisma generate

# Build the API
RUN cd apps/api && bun run build

WORKDIR /app/apps/api

# Run as non-root user for security
RUN groupadd -r bunjs -g 1001 && useradd -r -g bunjs -u 1001 bunjs
USER bunjs

EXPOSE 3001

CMD ["bun", "run", "start"]
