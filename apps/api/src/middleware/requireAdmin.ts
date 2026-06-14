import { createMiddleware } from "hono/factory";
import { auth } from "../lib/auth.js";
import type { HonoVariables } from "../types.js";

export const requireAdmin = createMiddleware<{ Variables: HonoVariables }>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session || !session.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", session.user);
  await next();
});
