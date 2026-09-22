/**
 * In-process test of the oRPC access levels. `createApp` is driven through
 * Hono's `app.request()` — no socket, and no BetterAuth rate limiter between
 * the test and the middleware under test.
 *
 * `lib/auth.js` is mocked, so the unauthenticated case touches neither
 * BetterAuth nor Postgres. The authenticated case does reach the handler (and
 * therefore the database) — that is the point: it proves `adminOs` hands the
 * session user through to the procedure.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as null | { user: { id: string } } }));

vi.mock("../../apps/api/src/lib/auth.js", () => ({
  auth: { api: { getSession: async () => session.current } },
}));

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

/** Calls an RPC procedure over the wire format Hono sees. */
function call(path: string, input: unknown): Promise<Response> | Response {
  return app.request(`/api/rpc/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: input }),
  });
}

beforeAll(async () => {
  // Vitest sets NODE_ENV=test, which lib/env.ts's enum rejects.
  process.env.NODE_ENV = "development";
  for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
    process.env[key] ??= value;
  }
  const { createApp } = await import("../../apps/api/src/index.js");
  app = createApp();
});

describe("oRPC access levels", () => {
  describe("Given no admin session", () => {
    describe("When calling an adminOs procedure", () => {
      it("Then it fails with UNAUTHORIZED before the handler runs", async () => {
        session.current = null;

        const res = await call("events/list", {});

        expect(res.status).toBe(401);
        const body = (await res.json()) as { json: { code: string } };
        expect(body.json.code).toBe("UNAUTHORIZED");
      });
    });
  });

  describe("Given an admin session", () => {
    describe("When calling an adminOs procedure", () => {
      it("Then the handler runs and answers", async () => {
        session.current = { user: { id: "test-admin" } };

        const res = await call("events/list", {});

        expect(res.status).toBe(200);
        const body = (await res.json()) as { json: unknown[] };
        expect(Array.isArray(body.json)).toBe(true);
      });
    });
  });

  describe("Given no gallery session cookie", () => {
    describe("When calling a galleryOs procedure", () => {
      it("Then it fails with UNAUTHORIZED before any database access", async () => {
        const res = await call("gallery/get", { slug: "any-slug" });

        expect(res.status).toBe(401);
        const body = (await res.json()) as { json: { code: string } };
        expect(body.json.code).toBe("UNAUTHORIZED");
      });
    });
  });

  describe("Given an admin who does not own the event", () => {
    describe("When calling a procedure guarded by requireOwner", () => {
      it("Then it fails with NOT_FOUND for an unknown event", async () => {
        session.current = { user: { id: "test-admin" } };

        const res = await call("events/get", { id: "no-such-event-xyz" });

        expect(res.status).toBe(404);
        const body = (await res.json()) as { json: { code: string } };
        expect(body.json.code).toBe("NOT_FOUND");
      });
    });
  });
});
