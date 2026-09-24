/**
 * In-process test of the oRPC mount. No socket, no Postgres, no BetterAuth —
 * `createApp` is driven through Hono's `app.request()`.
 *
 * `apps/api/src/lib/env.ts` parses process.env at import time, so the defaults
 * below must be in place before the app module is loaded (hence the dynamic
 * import).
 */
import { describe, it, expect, beforeAll } from "vitest";

const ENV_DEFAULTS: Record<string, string> = {
  DATABASE_URL: "postgresql://pixshar:pixshar@localhost:5432/pixshar?schema=public",
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-chars-long",
  GALLERY_ENCRYPTION_KEY: "deadbeef".repeat(8),
  BETTER_AUTH_URL: "http://localhost:3001",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "changeme",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "minioadmin",
  S3_SECRET_KEY: "minioadmin",
  S3_BUCKET: "pixshar",
  S3_FORCE_PATH_STYLE: "true",
  API_URL: "http://localhost:3001",
  WEB_URL: "http://localhost:3000",
};

let app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response };

beforeAll(async () => {
  // Vitest sets NODE_ENV=test, which lib/env.ts's enum rejects.
  process.env.NODE_ENV = "development";
  for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
    process.env[key] ??= value;
  }
  const { createApp } = await import("../../apps/api/src/index.js");
  app = createApp();
});

describe("oRPC mount", () => {
  describe("Given the app with the RPC handler mounted at /api/rpc", () => {
    describe("When calling a procedure whose contract declares NOT_FOUND", () => {
      it("Then it answers with the typed error shape, not a Hono 404", async () => {
        const res = await app.request("/api/rpc/gallery/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ json: { slug: "does-not-exist-xyz" } }),
        });

        expect(res.status).toBe(404);
        const body = (await res.json()) as { json: { code: string; message: string } };
        expect(body.json.code).toBe("NOT_FOUND");
      });
    });

    describe("When calling a path the RPC router does not own", () => {
      it("Then the non-RPC routes still match", async () => {
        const health = await app.request("/health");
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ status: "ok" });

        // The BetterAuth catch-all still answers (no cookie → null session).
        const session = await app.request("/api/auth/get-session");
        expect(session.status).toBe(200);
      });
    });
  });
});
