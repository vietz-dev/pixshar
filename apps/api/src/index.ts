import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { env } from "./lib/env.js";
import events from "./routes/events.js";
import gallery from "./routes/gallery.js";
import upload from "./routes/upload.js";
import auth from "./routes/auth.js";
import { startDebouncePoller } from "./services/downloadJob.js";

const app = new Hono({strict: false });

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

// Max request body size (100MB) — handles both Content-Length and Transfer-Encoding: chunked
app.use(bodyLimit({
  maxSize: 100 * 1024 * 1024,
  onError: (c) => c.json({ error: "Request body too large" }, 413),
}));

const api = app.basePath("/api");

api.route('/auth', auth);
api.route("/events", events);
api.route("/gallery", gallery);
api.route("/upload", upload);

// health checks
api.get("/health", (c) => c.json({ status: "ok" }));
app.get("/health", (c) => c.json({ status: "ok" }));

if (import.meta.main) {
  console.log(`API server running on http://localhost:${env.API_PORT}`);
  startDebouncePoller();
  Bun.serve({
    port: env.API_PORT,
    fetch: app.fetch,
  });
}
