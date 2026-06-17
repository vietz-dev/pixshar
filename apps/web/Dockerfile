# ============================================
# Stage 1: Dependencies Installation
# ============================================
FROM oven/bun:1 AS dependencies

# Set working directory
WORKDIR /app

# Copy root package files first to leverage Docker's caching mechanism
COPY package.json bun.lock* ./

# Copy workspace package.json files so bun install resolves workspaces
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

# Install project dependencies. --frozen-lockfile is omitted because the
# lockfile was generated on macOS and Bun sees platform differences in Linux.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --no-save

# ============================================
# Stage 2: Build Next.js application in standalone mode
# ============================================
FROM oven/bun:1 AS builder

# Set working directory
WORKDIR /app

# Copy project dependencies from dependencies stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application source code
COPY . .

ENV NODE_ENV=production

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
# ENV NEXT_TELEMETRY_DISABLED=1

# Build shared workspace package first (required by the web app)
RUN cd packages/shared && bun run build

# Build Next.js application
RUN cd apps/web && bun run build

# ============================================
# Stage 3: Run Next.js application
# ============================================
FROM oven/bun:1 AS runner

# Set working directory
WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the run time.
# ENV NEXT_TELEMETRY_DISABLED=1

# Copy the self-contained Next.js 16 standalone output. In a monorepo this is
# nested under apps/web/.next/standalone/ and includes its own node_modules/.bun
# store, so we preserve that structure rather than flattening.
COPY --from=builder --chown=bun:bun /app/apps/web/.next/standalone ./apps/web/.next/standalone

# Next.js 16 standalone output does not copy static chunks automatically.
# Copy them so /_next/static/* is served correctly.
COPY --from=builder --chown=bun:bun /app/apps/web/.next/static ./apps/web/.next/static

# Optional: copy public directory if it exists
# COPY --from=builder --chown=bun:bun /app/apps/web/public ./apps/web/public

# If you want to persist the fetch cache generated during the build so that
# cached responses are available immediately on startup, uncomment this line:
# COPY --from=builder --chown=bun:bun /app/apps/web/.next/cache ./apps/web/.next/cache

# Switch to non-root user for security best practices
USER bun

# Expose port 3000 to allow HTTP traffic
EXPOSE 3000

# Start Next.js standalone server with Bun
CMD ["bun", ".next/standalone/apps/web/server.js"]
