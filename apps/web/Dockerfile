FROM oven/bun:latest

WORKDIR /app

COPY packages/shared ./packages/shared
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web/tsconfig.json ./apps/web/tsconfig.json
COPY apps/web/next.config.ts ./apps/web/next.config.ts
COPY apps/web/next-env.d.ts ./apps/web/next-env.d.ts
COPY package.json ./package.json
COPY bun.lock ./bun.lock

RUN bun install --frozen-lockfile

COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
RUN cd packages/shared && bun run build

COPY apps/web/src ./apps/web/src

RUN cd apps/web && bun run build

WORKDIR /app/apps/web

EXPOSE 3000

CMD ["bun", "run", "start"]
