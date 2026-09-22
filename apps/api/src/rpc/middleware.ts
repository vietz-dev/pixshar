import { ORPCError, os } from "@orpc/server";
import { auth } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { checkRateLimit, getRateLimitKey } from "../lib/rateLimit.js";
import { base } from "./base.js";
import type { RpcContext } from "./context.js";

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

/**
 * Asserts the admin owns the event named by `input.id`. Replaces the
 * findUnique + 404 + 403 triad that was copied into every admin handler.
 */
export const requireOwner = os
  .$context<AdminContext>()
  .middleware(async ({ context, next }, input: { id: string }) => {
    const event = await prisma.event.findUnique({
      where: { id: input.id },
      select: { id: true, createdById: true },
    });
    if (!event) throw new ORPCError("NOT_FOUND", { message: "Event not found" });
    if (event.createdById !== context.user.id) {
      throw new ORPCError("FORBIDDEN", { message: "Forbidden" });
    }
    return next({ context: { event } });
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
