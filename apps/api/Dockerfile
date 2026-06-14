FROM oven/bun:latest

WORKDIR /app

# Copy workspace packages first
COPY packages/shared ./packages/shared
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY package.json ./package.json
COPY bun.lock ./bun.lock

# Install dependencies
RUN bun install --frozen-lockfile

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

EXPOSE 3001

CMD ["bun", "run", "start"]
