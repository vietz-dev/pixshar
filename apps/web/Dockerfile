FROM oven/bun:latest

WORKDIR /app

COPY packages/shared ./packages/shared
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web/tsconfig.json ./apps/web/tsconfig.json
COPY apps/web/next.config.ts ./apps/web/next.config.ts
COPY apps/web/next-env.d.ts ./apps/web/next-env.d.ts
COPY package.json ./package.json
COPY bun.lock ./bun.lock

RUN bun install

COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
RUN cd packages/shared && bun run build

COPY apps/web/src ./apps/web/src

RUN cd apps/web && bun run build

WORKDIR /app/apps/web

# Run as non-root user for security
RUN groupadd -r bunjs -g 1001 && useradd -r -g bunjs -u 1001 bunjs
USER bunjs

EXPOSE 3000

# With output: standalone, next start does not work. Use the standalone server directly.
CMD ["bun", ".next/standalone/apps/web/server.js"]
