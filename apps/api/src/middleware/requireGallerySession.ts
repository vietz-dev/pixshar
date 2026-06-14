import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { jwtVerify } from "jose";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import type { HonoVariables } from "../types.js";

const secret = new TextEncoder().encode(env.BETTER_AUTH_SECRET);

export const requireGallerySession = createMiddleware<{ Variables: HonoVariables }>(async (c, next) => {
  const slug = c.req.param("slug");
  const token = getCookie(c, `gallery_${slug}`);
  if (!token) {
    return c.json({ error: "Gallery session required" }, 401);
  }

  try {
    const { payload } = await jwtVerify(token, secret, { clockTolerance: 60 });
    const eventId = payload.eventId as string;
    const event = await prisma.event.findUnique({ where: { slug } });
    if (!event || event.id !== eventId) {
      return c.json({ error: "Invalid gallery session" }, 401);
    }
    c.set("galleryEvent", event);
    await next();
  } catch {
    return c.json({ error: "Invalid gallery session" }, 401);
  }
});
