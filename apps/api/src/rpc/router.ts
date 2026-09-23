import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { serialize as serializeCookie } from "hono/utils/cookie";
import { SignJWT } from "jose";
import { env } from "../lib/env.js";
import { encryptPassword, decryptPassword } from "../lib/crypto.js";
import { hashPassword, verifyPassword } from "../lib/hash.js";
import { galleryUnlocksTotal, photoDownloadsTotal } from "../lib/metrics.js";
import { prisma } from "../lib/prisma.js";
import { deleteS3Object, getPresignedUrl, s3 } from "../lib/s3.js";
import { completeUpload, initUpload } from "../lib/uploadInit.js";
import { base } from "./base.js";
import { adminOs, galleryOs, rateLimit, requireOwnedEvent, requireOwner } from "./middleware.js";

/** Processing counters for one event, straight off the Photo rows. */
async function photoStatusCounts(eventId: string) {
  const counts = await prisma.photo.groupBy({
    by: ["status"],
    where: { eventId },
    _count: { status: true },
  });
  const of = (status: string) =>
    counts.find((c: (typeof counts)[number]) => c.status === status)?._count.status ?? 0;
  const [pending, processed, failed] = [of("PENDING"), of("PROCESSED"), of("FAILED")];
  return { pending, processed, failed, total: pending + processed + failed };
}

const jwtSecret = new TextEncoder().encode(env.BETTER_AUTH_SECRET);

const eventSummarySelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  status: true,
  createdAt: true,
} as const;

export const router = base.router({
  events: {
    list: adminOs.events.list
      .use(rateLimit({ key: () => "list-events", limit: 60, windowMs: 60_000 }))
      .handler(() =>
        prisma.event.findMany({
          orderBy: { createdAt: "desc" },
          select: { ...eventSummarySelect, _count: { select: { photos: true } } },
        }),
      ),

    create: adminOs.events.create
      .use(rateLimit({ key: () => "create-event", limit: 50, windowMs: 60_000 }))
      .handler(async ({ input, context, errors }) => {
        const existing = await prisma.event.findUnique({
          where: { slug: input.slug },
          select: { id: true },
        });
        if (existing) throw errors.CONFLICT({ message: "Slug already exists" });

        return prisma.event.create({
          data: {
            name: input.name,
            slug: input.slug,
            description: input.description || null,
            passwordHash: await hashPassword(input.password),
            password: encryptPassword(input.password),
            createdById: context.user.id,
            status: "READY",
          },
          select: eventSummarySelect,
        });
      }),

    get: adminOs.events.get
      .use(
        rateLimit({
          key: (input: { id: string }) => `event-detail:${input.id}`,
          limit: 60,
          windowMs: 60_000,
        }),
      )
      .use(requireOwner)
      .handler(async ({ input }) => {
        const event = await prisma.event.findUniqueOrThrow({
          where: { id: input.id },
          select: {
            ...eventSummarySelect,
            password: true,
            photos: { orderBy: { createdAt: "desc" } },
          },
        });

        const photos = await Promise.all(
          event.photos.map(async (photo) => ({
            ...photo,
            thumbUrl: photo.thumbKey ? await getPresignedUrl(photo.thumbKey, "get", 3600) : "",
            displayUrl: photo.displayKey
              ? await getPresignedUrl(photo.displayKey, "get", 3600)
              : "",
          })),
        );

        return {
          ...event,
          password: event.password ? decryptPassword(event.password) : null,
          photos,
        };
      }),

    setPassword: adminOs.events.setPassword
      .use(requireOwner)
      .handler(async ({ input, context }) => {
        await prisma.event.update({
          where: { id: context.event.id },
          data: {
            password: encryptPassword(input.password),
            passwordHash: await hashPassword(input.password),
          },
        });
        return { success: true as const };
      }),

    delete: adminOs.events.delete.use(requireOwner).handler(async ({ context }) => {
      // Best-effort S3 cleanup under the event prefix; the row goes either way.
      try {
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: `${context.event.id}/` }),
        );
        for (const obj of list.Contents ?? []) {
          if (obj.Key) await deleteS3Object(obj.Key);
        }
      } catch {
        // S3 cleanup failed, continue with DB delete
      }

      await prisma.event.delete({ where: { id: context.event.id } });
      return { success: true as const };
    }),
  },

  gallery: {
    // Public — returns only name/description so the gate page can show the
    // event title before the guest authenticates.
    info: base.gallery.info.handler(async ({ input, errors }) => {
      const event = await prisma.event.findUnique({
        where: { slug: input.slug },
        select: { id: true, name: true, description: true },
      });
      if (!event) throw errors.NOT_FOUND({ message: "Gallery not found" });
      return event;
    }),

    unlock: base.gallery.unlock
      .use(
        rateLimit({
          key: (input: { slug: string }) => `unlock:${input.slug}`,
          limit: 5,
          windowMs: 60_000,
        }),
      )
      .handler(async ({ input, context, errors }) => {
        const event = await prisma.event.findUnique({ where: { slug: input.slug } });
        if (!event) throw errors.NOT_FOUND({ message: "Gallery not found" });

        const valid = await verifyPassword(input.password, event.passwordHash);
        galleryUnlocksTotal.inc({ result: valid ? "success" : "failure" });
        if (!valid) throw errors.UNAUTHORIZED({ message: "Invalid password" });

        const token = await new SignJWT({ eventId: event.id })
          .setProtectedHeader({ alg: "HS256" })
          .setExpirationTime("7d")
          .sign(jwtSecret);

        // Set-Cookie from inside a procedure, via the response-headers plugin.
        context.resHeaders?.append(
          "Set-Cookie",
          serializeCookie(`gallery_${input.slug}`, token, {
            httpOnly: true,
            secure: env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 60 * 60 * 24 * 7,
            path: "/",
          }),
        );

        return { success: true as const };
      }),

    get: base.gallery.get
      .use(
        rateLimit({
          key: (input: { slug: string }) => `gallery-get:${input.slug}`,
          limit: 120,
          windowMs: 60_000,
        }),
      )
      .use(galleryOs)
      .handler(async ({ context }) => {
        const event = context.galleryEvent;
        const photos = await prisma.photo.findMany({
          where: { eventId: event.id, status: "PROCESSED" },
          orderBy: { createdAt: "desc" },
        });

        return {
          id: event.id,
          slug: event.slug,
          name: event.name,
          description: event.description,
          photos: await Promise.all(
            photos.map(async (photo) => ({
              id: photo.id,
              photographerName: photo.photographerName,
              thumbUrl: await getPresignedUrl(photo.thumbKey, "get", 3600),
              displayUrl: await getPresignedUrl(photo.displayKey, "get", 3600),
              status: photo.status,
              placeholderDataUrl: photo.placeholderDataUrl ?? null,
            })),
          ),
        };
      }),

    photoDownload: base.gallery.photoDownload
      .use(
        rateLimit({
          key: (input: { slug: string }) => `photo-dl:${input.slug}`,
          limit: 60,
          windowMs: 60_000,
        }),
      )
      .use(galleryOs)
      .handler(async ({ input, context, errors }) => {
        const photo = await prisma.photo.findUnique({
          where: { id: input.photoId, eventId: context.galleryEvent.id },
        });
        if (!photo) throw errors.NOT_FOUND({ message: "Photo not found" });

        const filename = `${(photo.photographerName || "photo").replace(/[^a-zA-Z0-9_-]/g, "_")}-${photo.id}.jpg`;
        const url = await getPresignedUrl(
          photo.originalKey,
          "get",
          60 * 60,
          `attachment; filename="${filename}"`,
        );
        photoDownloadsTotal.inc({ actor: "guest" });
        return { url };
      }),

    upload: {
      init: base.gallery.upload.init
        .use(
          rateLimit({
            key: (input: { slug: string }) => `upload:${input.slug}`,
            limit: 50,
            windowMs: 60_000,
          }),
        )
        .use(galleryOs)
        .handler(async ({ input, context }) => ({
          photos: await initUpload({
            eventId: context.galleryEvent.id,
            uploadedBy: "GUEST",
            photographerName: input.photographerName?.trim().slice(0, 100) || null,
            files: input.files,
          }),
        })),

      complete: base.gallery.upload.complete.use(galleryOs).handler(async ({ input, context }) => {
        await completeUpload(context.galleryEvent.id, input.photoIds);
        return { ok: true as const };
      }),
    },
  },

  upload: {
    // Step 1 — dedup the requested files and hand back presigned PUT URLs.
    // The browser PUTs the originals straight to S3; no bytes touch the API.
    init: adminOs.upload.init
      .use(
        rateLimit({
          key: (input: { eventId: string }) => `admin-upload:${input.eventId}`,
          limit: 100,
          windowMs: 60_000,
        }),
      )
      .use(requireOwnedEvent)
      .handler(async ({ input, context }) => ({
        photos: await initUpload({
          eventId: context.event.id,
          uploadedBy: "ADMIN",
          photographerName: input.photographerName?.trim().slice(0, 100) || null,
          files: input.files,
        }),
      })),

    // Step 2 — the client confirms which uploads landed; wake the worker.
    complete: adminOs.upload.complete.use(requireOwnedEvent).handler(async ({ input, context }) => {
      await completeUpload(context.event.id, input.photoIds);
      return { ok: true as const };
    }),

    status: adminOs.upload.status
      .use(
        rateLimit({
          key: (input: { eventId: string }) => `upload-status:${input.eventId}`,
          limit: 60,
          windowMs: 60_000,
        }),
      )
      .use(requireOwnedEvent)
      .handler(({ context }) => photoStatusCounts(context.event.id)),
  },
});
