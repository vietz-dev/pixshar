import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("production"),
  DATABASE_URL: z.string(),
  BETTER_AUTH_SECRET: z.string().min(32),
  GALLERY_ENCRYPTION_KEY: z.string().length(64).regex(/^[0-9a-f]+$/, "Must be 64 lowercase hex chars (32 bytes)"),
  BETTER_AUTH_URL: z.string().url(),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_PUBLIC_URL: z.string().url().optional(),
  // Endpoint the *browser* uses to reach S3 for presigned URLs. Presigned URLs
  // are signed against their host, so when the API talks to S3 over an internal
  // hostname (e.g. http://garage:3900 in Docker) the browser cannot reach, this
  // must be the externally reachable host (e.g. http://localhost:3900).
  // Defaults to S3_ENDPOINT when the API and browser share a host.
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  // Whether presigned URLs use path-style (host/bucket/key) instead of
  // virtual-hosted style (bucket.host/key). MinIO (the bundled self-host store)
  // needs path-style; most hosted providers (Tigris, R2) need virtual-hosted to
  // avoid a 307 redirect that re-uploads the whole body. Defaults to false
  // (virtual-hosted) to preserve hosted deployments; the bundled Docker/Helm
  // MinIO setup sets this to "true".
  S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  API_PORT: z.string().transform(Number).default("3001"),
  API_URL: z.string().url(),
  WEB_URL: z.string().url(),
  // Resize queue (pg-boss)
  PROCESS_MAX_ATTEMPTS: z.string().transform(Number).default("4"),
  // Minimum age before a newly-uploaded photo is eligible for processing.
  // Used as boss.send startAfter (seconds) so S3 has time to make the object consistent.
  PROCESS_MIN_AGE_MS: z.string().transform(Number).default("3000"),
  // Worker pool
  WORKER_CONCURRENCY: z.string().transform(Number).default("2"),
  WORKER_METRICS_PORT: z.string().transform(Number).default("4000"),
  // Zip archive job (downloadJob.ts)
  DOWNLOAD_DEBOUNCE_SECONDS: z.string().transform(Number).default("60"),
  DOWNLOAD_MAX_WAIT_SECONDS: z.string().transform(Number).default("120"),
  DOWNLOAD_BUILD_LEASE_SECONDS: z.string().transform(Number).default("300"),
  // Max size of a single archive part. Guests download parts individually, so
  // an interrupted download only loses one part, not the whole gallery. 2 GiB.
  DOWNLOAD_MAX_PART_BYTES: z.string().transform(Number).default("2147483648"),
});

export const env = schema.parse(process.env);
