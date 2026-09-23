import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { env } from "./lib/env.js";
import events from "./routes/events.js";
import gallery from "./routes/gallery.js";
import upload from "./routes/upload.js";
import auth from "./routes/auth.js";
import backfill from "./routes/backfill.js";
import metricsRoute from "./routes/metrics.js";
import { initDatabase } from "./lib/prisma.js";
import { startBoss } from "./lib/pgboss.js";
import { startPgNotifyListener } from "./lib/pgNotifyListener.js";
import { httpRequestsTotal, httpRequestDuration } from "./lib/metrics.js";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { onError } from "@orpc/server";
import { router } from "./rpc/router.js";
import { defaultResolveContext, type ContextResolver } from "./rpc/context.js";
import { dispose } from "./runtime.js";

const rpcHandler = new RPCHandler(router, {
  interceptors: [onError((error) => console.error("[RPC]", error))],
  // Lets procedures write response headers via `context.resHeaders`
  // (gallery.unlock sets the gallery session cookie that way).
  plugins: [new ResponseHeadersPlugin()],
});

/**
 * Builds the Hono app. `resolveContext` is injectable so the oRPC surface can
 * be driven in-process by tests with no socket, no Postgres and no BetterAuth.
 */
export function createApp(resolveContext: ContextResolver = defaultResolveContext) {
  const app = new Hono({ strict: false });

  app.use(logger());
  app.use(
    cors({
      origin: env.WEB_URL,
      credentials: true,
    }),
  );

  // Security headers
  app.use(async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("X-XSS-Protection", "1; mode=block");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (env.NODE_ENV === "production") {
      c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    }
    await next();
  });

  // Max request body size (100MB) — handles both Content-Length and Transfer-Encoding: chunked
  app.use(
    bodyLimit({
      maxSize: 100 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
  );

  // HTTP metrics — skip SSE streams (they stay open indefinitely, skewing histograms)
  app.use(async (c, next) => {
    const start = performance.now();
    await next();
    if (c.req.routePath?.endsWith("/stream")) return;
    const duration = (performance.now() - start) / 1000;
    const labels = {
      method: c.req.method,
      route: c.req.routePath || "unknown",
      status_code: String(c.res.status),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, duration);
  });

  // oRPC mount — must come before the legacy /api routers so RPC traffic is
  // not swallowed by them. Non-overlapping with /api/auth/*.
  app.use("/api/rpc/*", async (c, next) => {
    const context = await resolveContext(c.req.raw);
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix: "/api/rpc",
      context,
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  const api = app.basePath("/api");

  api.route("/auth", auth);
  api.route("/events", events);
  api.route("/gallery", gallery);
  api.route("/upload", upload);

  // health checks
  api.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Prometheus metrics — no auth, reachable only within the cluster via ClusterIP
  app.route("/api/admin/backfill", backfill);
  app.route("/metrics", metricsRoute);

  return app;
}

if (import.meta.main) {
  console.log(`API server running on http://localhost:${env.API_PORT}`);
  await initDatabase();
  const boss = await startBoss();
  await startPgNotifyListener();
  const server = Bun.serve({
    port: env.API_PORT,
    // SSE streams are mostly idle between events; Bun's default idleTimeout
    // (~10s) would close them before the keepalive ping. Raise it well past the
    // keepalive interval so long-lived event streams stay open.
    idleTimeout: 120,
    fetch: createApp().fetch,
  });

  process.on("SIGTERM", async () => {
    console.log("[API] SIGTERM — graceful shutdown");
    // Stop accepting new connections; wait for in-flight requests to complete.
    server.stop(true);
    // Release the request-side Effect runtime's scoped resources.
    await dispose();
    await boss.stop({ graceful: true });
    process.exit(0);
  });
}
