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

## Kubernetes Deployment

### GitHub Actions Release

Push a tag to automatically build and publish everything:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This triggers the release workflow that:
1. Runs tests (`tsc`, `next build`, Helm lint)
2. Builds and pushes Docker images to `ghcr.io/<owner>/pixshar-api` and `ghcr.io/<owner>/pixshar-web`
3. Packages and pushes the Helm chart to `ghcr.io/<owner>/pixshar`

### Install from ghcr.io

```bash
# Create your secret
kubectl create secret generic pixshar-secrets \
  --namespace pixshar \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ADMIN_EMAIL="admin@example.com" \
  --from-literal=ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=S3_ACCESS_KEY="..." \
  --from-literal=S3_SECRET_KEY="..."

# Install the chart
helm install pixshar oci://ghcr.io/$(OWNER)/pixshar --version v1.0.0 \
  --namespace pixshar \
  --set secrets.existingSecret=pixshar-secrets \
  --set config.webUrl="https://photos.example.com" \
  --set config.apiUrl="https://photos.example.com/api" \
  --set config.s3Endpoint="https://s3.wasabisys.com" \
  --set config.s3Bucket="my-pixshar" \
  --set config.s3Region="eu-central-1" \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=photos.example.com
```

See [helm/pixshar/README.md](helm/pixshar/README.md) for full configuration.

## Stack

- **Frontend:** Next.js 15 (App Router)
- **Backend:** Hono + Bun + Effect
- **Auth:** BetterAuth (single admin)
- **ORM:** Prisma + SQLite
- **Storage:** Garage S3-compatible
- **Infra:** Docker Compose + Helm Chart (Kubernetes)
