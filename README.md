# Pixshar

A self-hostable, private event photo sharing app.

## Quick Start

```bash
# 1. Copy env template
cp .env.example .env
# Edit .env and set BETTER_AUTH_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD

# 2. Install dependencies
bun install

# 3. Start the dev stack
bun run dev
```

## Docker Compose

```bash
# Start everything (Garage S3, API, Web, Garage UI)
docker compose up --build
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| Web | [http://localhost:3000](http://localhost:3000) | Next.js frontend |
| API | [http://localhost:3001](http://localhost:3001) | Hono API + BetterAuth |
| Garage S3 | [http://localhost:3900](http://localhost:3900) | S3-compatible object storage |
| **Garage UI** | [http://localhost:8080](http://localhost:8080) | Web dashboard for managing Garage buckets |

### Garage UI

[Garage UI](https://github.com/Noooste/garage-ui) is included for easy local development. It lets you browse buckets, manage access keys, and monitor your Garage cluster from the browser.

- **URL:** http://localhost:8080
- **Login:** Use the Garage admin token from your `.env` file (default: `dev-admin-token-do-not-use-in-production`)

### Dev Commands

```bash
cd apps/api && bunx prisma migrate dev --name init
bun run dev          # API + Web
```

## Stack

- **Frontend:** Next.js 15 (App Router)
- **Backend:** Hono + Bun + Effect
- **Auth:** BetterAuth (single admin)
- **ORM:** Prisma + SQLite
- **Storage:** Garage S3-compatible
- **Infra:** Docker Compose
