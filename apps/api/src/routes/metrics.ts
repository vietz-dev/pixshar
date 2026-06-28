import { Hono } from "hono";
import { register } from "../lib/metrics.js";

const app = new Hono();

app.get("/", async (c) => {
  const body = await register.metrics();
  return c.text(body, 200, { "Content-Type": register.contentType });
});

export default app;
