import { ORPCError, os } from "@orpc/server";
import type { Event } from "@prisma/client";
import { parse as parseCookie } from "hono/utils/cookie";
import { jwtVerify } from "jose";
import { auth } from "../lib/auth.js";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import { checkRateLimit, getRateLimitKey } from "../lib/rateLimit.js";
import { base } from "./base.js";
import type { RpcContext } from "./context.js";

const jwtSecret = new TextEncoder().encode(env.BETTER_AUTH_SECRET);

type SessionUser = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>["user"];

/** Context after `adminOs` — an authenticated BetterAuth admin session. */
export type AdminContext = RpcContext & { user: SessionUser };

/**
 * Admin access level. Every procedure built from `adminOs` has a verified
 * session user in context; unauthenticated calls never reach the handler.
 */
export const adminOs = base.use(async ({ context, next }) => {
  const session = await auth.api.getSession({ headers: context.headers });
  if (!session?.user) throw new ORPCError("UNAUTHORIZED", { message: "Unauthorized" });
  return next({ context: { user: session.user } });
});

/** The findUnique + 404 + 403 triad that was copied into every admin handler. */
async function assertOwned(eventId: string, userId: string) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, createdById: true },
  });
  if (!event) throw new ORPCError("NOT_FOUND", { message: "Event not found" });
  if (event.createdById !== userId) throw new ORPCError("FORBIDDEN", { message: "Forbidden" });
  return event;
}

/** Asserts the admin owns the event named by `input.id`. */
export const requireOwner = os
  .$context<AdminContext>()
  .middleware(async ({ context, next }, input: { id: string }) => {
    return next({ context: { event: await assertOwned(input.id, context.user.id) } });
  });

/** Same, for procedures whose input names the event `eventId` (the upload pair). */
export const requireOwnedEvent = os
  .$context<AdminContext>()
  .middleware(async ({ context, next }, input: { eventId: string }) => {
    return next({ context: { event: await assertOwned(input.eventId, context.user.id) } });
  });

/**
 * Per-IP fixed-window rate limit, declared at the procedure instead of open
 * coded in the handler. `key` derives the bucket prefix from the input, so
 * per-event limits stay per-event.
 */
export function rateLimit<TInput>(opts: {
  key: (input: TInput) => string;
  limit: number;
  windowMs: number;
}) {
  return os
    .$context<RpcContext>()
    .middleware<Record<never, never>, TInput>(async ({ context, next }, input) => {
      const header = (name: string) => context.headers.get(name) ?? undefined;
      const bucket = getRateLimitKey({ req: { header } }, opts.key(input));
      if (!checkRateLimit(bucket, opts.limit, opts.windowMs)) {
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: "Too many requests. Please try again later.",
        });
      }
      return next();
    });
}

/** Context after `galleryOs` — a verified gallery session for `input.slug`. */
export type GalleryContext = RpcContext & { galleryEvent: Event };

/**
 * Guest access level. Verifies the `gallery_<slug>` JWT cookie against the slug
 * named in the input, so a session for one gallery cannot read another.
 * Only fits procedures whose input carries `slug`.
 */
export const galleryOs = os
  .$context<RpcContext>()
  .middleware(async ({ context, next }, input: { slug: string }) => {
    const name = `gallery_${input.slug}`;
    const token = parseCookie(context.headers.get("cookie") ?? "", name)[name];
    if (!token) throw new ORPCError("UNAUTHORIZED", { message: "Gallery session required" });

    try {
      const { payload } = await jwtVerify(token, jwtSecret, { clockTolerance: 60 });
      const event = await prisma.event.findUnique({ where: { slug: input.slug } });
      if (!event || event.id !== payload.eventId) throw new Error("mismatch");
      return next({ context: { galleryEvent: event } });
    } catch {
      throw new ORPCError("UNAUTHORIZED", { message: "Invalid gallery session" });
    }
  });
