# Pixshar Helm Chart

A production-ready Helm chart for deploying [Pixshar](https://github.com/pixshar/pixshar) — a self-hosted, private event photo sharing app — on Kubernetes.

## Prerequisites

- Kubernetes 1.24+
- Helm 3.12+
- Ingress controller (nginx, traefik, or compatible)
- S3-compatible storage (AWS S3, Garage, MinIO, Wasabi, etc.)
- Container images built and pushed to a registry

## Architecture

The chart deploys two components:

| Component | Description | Port |
|-----------|-------------|------|
| **API** | Hono + Bun + Prisma + Postgres backend | 3001 |
| **Web** | Next.js 15 frontend (proxies `/api/*` to API) | 3000 |

## Quick Start

### 1. Build and push images (or use CI)

The repository includes a GitHub Actions workflow that automatically builds and pushes images when you push a tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Images are pushed to `ghcr.io/<owner>/pixshar-api` and `ghcr.io/<owner>/pixshar-web`.

Alternatively, build locally:

```bash
docker build -t ghcr.io/<owner>/pixshar-api:latest -f apps/api/Dockerfile .
docker build -t ghcr.io/<owner>/pixshar-web:latest -f apps/web/Dockerfile .
docker push ghcr.io/<owner>/pixshar-api:latest
docker push ghcr.io/<owner>/pixshar-web:latest
```

### 2. Create a secret (recommended for production)

```bash
kubectl create namespace pixshar
kubectl create secret generic pixshar-secrets \
  --namespace pixshar \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ADMIN_EMAIL="admin@example.com" \
  --from-literal=ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=S3_ACCESS_KEY="your-s3-access-key" \
  --from-literal=S3_SECRET_KEY="your-s3-secret-key"
```

### 3. Install the chart

```bash
helm install pixshar ./helm/pixshar \
  --namespace pixshar \
  --set secrets.existingSecret=pixshar-secrets \
  --set api.image.repository=ghcr.io/<owner>/pixshar-api \
  --set api.image.tag=v1.0.0 \
  --set web.image.repository=ghcr.io/<owner>/pixshar-web \
  --set web.image.tag=v1.0.0 \
  --set config.webUrl="https://photos.example.com" \
  --set config.apiUrl="https://photos.example.com/api" \
  --set config.betterAuthUrl="https://photos.example.com/api" \
  --set config.s3Endpoint="https://s3.eu-central-1.wasabisys.com" \
  --set config.s3Bucket="my-pixshar-bucket" \
  --set config.s3Region="eu-central-1" \
  --set config.s3PublicUrl="https://s3.eu-central-1.wasabisys.com/my-pixshar-bucket" \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set "ingress.hosts[0].host=photos.example.com" \
  --set "ingress.annotations.cert-manager.io/cluster-issuer=letsencrypt"
```

### 4. Access the app

```bash
kubectl get ingress -n pixshar
```

Log in with the admin email and password from your secret.

## Configuration

### Secrets

All sensitive values are stored in a Kubernetes Secret. You can either:

1. **Create the secret manually** (recommended for production):
   ```bash
   kubectl create secret generic pixshar-secrets --namespace pixshar \
     --from-literal=BETTER_AUTH_SECRET="..." \
     --from-literal=ADMIN_EMAIL="..." \
     --from-literal=ADMIN_PASSWORD="..." \
     --from-literal=S3_ACCESS_KEY="..." \
     --from-literal=S3_SECRET_KEY="..."
   ```
   Then set `secrets.existingSecret=pixshar-secrets`.

2. **Let the chart create the secret** (convenient for testing):
   ```yaml
   secrets:
     betterAuthSecret: "your-secret"
     adminEmail: "admin@example.com"
     adminPassword: "your-password"
     s3AccessKey: "your-key"
     s3SecretKey: "your-secret"
   ```

### S3 Configuration

Pixshar requires an S3-compatible bucket for photo storage. The chart does **not** deploy S3 — you must bring your own:

| Service | Example `s3Endpoint` |
|---------|---------------------|
| AWS S3 | `https://s3.amazonaws.com` |
| Wasabi | `https://s3.eu-central-1.wasabisys.com` |
| Garage (self-hosted) | `http://garage.your-cluster.svc.cluster.local:3900` |
| MinIO | `http://minio.your-cluster.svc.cluster.local:9000` |

### Ingress

By default, all traffic is routed to the **web** service. The Next.js app proxies `/api/*` to the API service internally.

If you prefer to route `/api/*` directly to the API service in the ingress (bypassing the web proxy), set:

```yaml
ingress:
  apiDirectRouting: true
```

### Database (Postgres)

Pixshar uses Postgres. The API is stateless — no PVC — so it scales horizontally; durability lives in Postgres. There are three ways to wire it up.

**1. Link an existing Postgres via a ready-made DSN secret (recommended).**
A managed operator like CloudNativePG (CNPG) publishes a full `postgres://…` connection string under the `uri` key of its `<cluster>-app` secret. Point the chart at it (sync the secret with openBAO / External Secrets if you like):

```yaml
postgres:
  enabled: false
externalDatabase:
  existingSecret: "mycluster-app"   # the CNPG app secret
  existingSecretUrlKey: "uri"        # default
```

**2. Link an existing Postgres by parts**, with the password from a secret key:

```yaml
postgres:
  enabled: false
externalDatabase:
  existingSecret: "my-db-creds"
  existingSecretUrlKey: ""            # disable the DSN path
  existingSecretPasswordKey: "password"
  host: postgres.db.svc.cluster.local
  port: 5432
  database: pixshar
  username: pixshar
  sslmode: require
```

**3. Bundled fallback** — a single-replica `pixshar-postgres` StatefulSet (testing / small self-host):

```yaml
postgres:
  enabled: true
  auth:
    username: pixshar
    database: pixshar
    password: "change-me"            # or set auth.existingSecret (key: password)
  persistence:
    size: 8Gi
    storageClass: "fast-ssd"         # optional
```

Migrations (`prisma migrate deploy`) and the admin seed run from an init container on every rollout; both are idempotent, so they are safe with multiple API replicas.

### Autoscaling

Enable HorizontalPodAutoscaler for both components:

```yaml
api:
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 5
    targetCPUUtilizationPercentage: 80

web:
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilizationPercentage: 80
```

## Values

| Key | Default | Description |
|-----|---------|-------------|
| `secrets.existingSecret` | `""` | Use an existing secret instead of creating one |
| `secrets.betterAuthSecret` | `""` | BetterAuth secret (min 32 chars) |
| `secrets.adminEmail` | `"admin@example.com"` | Admin email |
| `secrets.adminPassword` | `""` | Admin password |
| `secrets.s3AccessKey` | `""` | S3 access key |
| `secrets.s3SecretKey` | `""` | S3 secret key |
| `config.webUrl` | `"https://pixshar.local"` | Public URL of the web app |
| `config.apiUrl` | `"https://pixshar.local/api"` | Public URL for API callbacks |
| `config.betterAuthUrl` | `"https://pixshar.local/api"` | BetterAuth base URL |
| `config.s3Endpoint` | `"https://s3.amazonaws.com"` | S3 API endpoint |
| `config.s3Bucket` | `"pixshar"` | S3 bucket name |
| `config.s3Region` | `"us-east-1"` | S3 region |
| `config.s3PublicUrl` | `""` | Public URL for S3 objects (optional) |
| `config.downloadDebounceSeconds` | `60` | ZIP archive debounce timer (quiet period) |
| `postgres.enabled` | `false` | Spin up the bundled `pixshar-postgres` StatefulSet |
| `postgres.auth.username` | `pixshar` | Bundled DB user |
| `postgres.auth.database` | `pixshar` | Bundled DB name |
| `postgres.auth.password` | `""` | Bundled DB password (or use `auth.existingSecret`) |
| `postgres.auth.existingSecret` | `""` | Secret holding key `password` for the bundled DB |
| `postgres.persistence.size` | `8Gi` | Bundled DB volume size |
| `externalDatabase.existingSecret` | `""` | Secret holding the external DB credentials |
| `externalDatabase.existingSecretUrlKey` | `"uri"` | Secret key with a full DSN (CNPG). Empty = assemble from parts |
| `externalDatabase.existingSecretPasswordKey` | `"password"` | Secret key with the password (parts mode) |
| `externalDatabase.host` / `.port` / `.database` / `.username` / `.sslmode` | — | External DB parts (parts mode) |
| `api.image.repository` | `"pixshar/api"` | API image repository |
| `api.image.tag` | `""` | API image tag (defaults to appVersion) |
| `api.replicaCount` | `1` | API replicas |
| `api.resources` | see `values.yaml` | API resource requests/limits |
| `api.autoscaling.enabled` | `false` | Enable API HPA |
| `web.image.repository` | `"pixshar/web"` | Web image repository |
| `web.image.tag` | `""` | Web image tag (defaults to appVersion) |
| `web.replicaCount` | `1` | Web replicas |
| `web.resources` | see `values.yaml` | Web resource requests/limits |
| `web.autoscaling.enabled` | `false` | Enable web HPA |
| `ingress.enabled` | `true` | Enable ingress |
| `ingress.className` | `"nginx"` | Ingress class name |
| `ingress.hosts` | see `values.yaml` | Ingress host rules |
| `ingress.tls` | `[]` | TLS configuration |
| `ingress.apiDirectRouting` | `false` | Route `/api/*` directly to API |
| `serviceAccount.create` | `true` | Create service account |
| `serviceAccount.automount` | `false` | Auto-mount SA token |

## Security

- Containers run as non-root (`runAsUser: 1001`, `runAsNonRoot: true`)
- Root filesystem is read-only (`readOnlyRootFilesystem: true`)
- Privilege escalation is disabled (`allowPrivilegeEscalation: false`)
- All capabilities are dropped
- Service account token auto-mounting is disabled by default
- Secrets are stored in Kubernetes Secrets (not in ConfigMaps)
- The API is stateless; durable data lives in Postgres

## Uninstall

```bash
helm uninstall pixshar --namespace pixshar
```

If you used the bundled Postgres, its data volume is retained on uninstall. To also delete it:

```bash
kubectl delete pvc -n pixshar -l app.kubernetes.io/component=postgres
```
