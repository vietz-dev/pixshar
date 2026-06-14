import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { auth } from "./lib/auth.js";
import { env } from "./lib/env.js";
import events from "./routes/events.js";
import gallery from "./routes/gallery.js";
import upload from "./routes/upload.js";
import { startDebouncePoller } from "./services/downloadJob.js";

const app = new Hono();

app.use(logger());
app.use(cors({
  origin: env.WEB_URL,
  credentials: true,
}));

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

// Max request body size (100MB)
const MAX_BODY_SIZE = 100 * 1024 * 1024;
app.use(async (c, next) => {
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return c.json({ error: "Request body too large" }, 413);
  }
  await next();
});

// BetterAuth routes
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// API routes
app.route("/api/events", events);
app.route("/api/gallery", gallery);
app.route("/api/upload", upload);

app.get("/health", (c) => c.json({ status: "ok" }));

if (import.meta.main) {
  console.log(`API server running on http://localhost:${env.API_PORT}`);
  startDebouncePoller();
  Bun.serve({
    port: env.API_PORT,
    fetch: app.fetch,
  });
}
