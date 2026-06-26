import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("production"),
  DATABASE_URL: z.string(),
  BETTER_AUTH_SECRET: z.string().min(32),
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
  API_PORT: z.string().transform(Number).default("3001"),
  API_URL: z.string().url(),
  WEB_URL: z.string().url(),
  DOWNLOAD_DEBOUNCE_SECONDS: z.string().transform(Number).default("600"),
});

export const env = schema.parse(process.env);
