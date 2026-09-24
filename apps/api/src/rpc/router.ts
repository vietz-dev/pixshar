import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { serialize as serializeCookie } from "hono/utils/cookie";
import { SignJWT } from "jose";
import { env } from "../lib/env.js";
import { encryptPassword, decryptPassword } from "../lib/crypto.js";
import { hashPassword, verifyPassword } from "../lib/hash.js";
import { galleryUnlocksTotal, photoDownloadsTotal } from "../lib/metrics.js";
import { prisma } from "../lib/prisma.js";
import { deleteS3Object, getPresignedUrl, s3 } from "../lib/s3.js";
import { getBoss } from "../lib/pgboss.js";
import { completeUpload, initUpload } from "../lib/uploadInit.js";
import { runService } from "../runtime.js";
import { DownloadService } from "../services/download/service.js";
import { triggerReconcileAllVariants } from "../services/downloadJob.js";
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

/**
 * Deleting photos invalidates the already-built (immutable) archive parts that
 * contain them: mark exactly those parts STALE and reconcile both variants, so
 * a guest who already pulled an unaffected part is not forced to re-fetch it.
 */
async function staleArchivePartsForPhotos(eventId: string, photoIds: string[]): Promise<void> {
  if (photoIds.length === 0) return;
  const affected = await prisma.downloadArchivePart.updateMany({
    where: {
      job: { eventId },
      status: "READY",
      entries: { some: { photoId: { in: photoIds } } },
    },
    data: { status: "STALE" },
  });
  if (affected.count > 0) await triggerReconcileAllVariants(eventId);
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
  admin: {
    backfillStatus: adminOs.admin.backfillStatus.handler(async () => {
      const [total, missing] = await Promise.all([
        prisma.photo.count({ where: { status: "PROCESSED" } }),
        prisma.photo.count({ where: { status: "PROCESSED", placeholderDataUrl: null } }),
      ]);
      return { total, missing };
    }),
  },

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

    photoDownload: adminOs.events.photoDownload
      .use(
        rateLimit({
          key: (input: { id: string }) => `admin-photo-dl:${input.id}`,
          limit: 60,
          windowMs: 60_000,
        }),
      )
      .use(requireOwner)
      .handler(async ({ input, errors }) => {
        const photo = await prisma.photo.findUnique({
          where: { id: input.photoId, eventId: input.id },
        });
        if (!photo) throw errors.NOT_FOUND({ message: "Photo not found" });

        const filename = `${(photo.photographerName || "photo").replace(/[^a-zA-Z0-9_-]/g, "_")}-${photo.id}.jpg`;
        const url = await getPresignedUrl(
          photo.originalKey,
          "get",
          60 * 60,
          `attachment; filename="${filename}"`,
        );
        photoDownloadsTotal.inc({ actor: "admin" });
        return { url };
      }),

    // Photo maintenance. Ownership is asserted by `requireOwner`, so these
    // handlers only carry the work itself.
    photos: {
      retry: adminOs.events.photos.retry.use(requireOwner).handler(async ({ context }) => {
        const failed = await prisma.photo.findMany({
          where: { eventId: context.event.id, status: "FAILED" },
          select: { id: true },
        });

        const res = await prisma.photo.updateMany({
          where: { eventId: context.event.id, status: "FAILED" },
          data: { status: "PENDING", attempts: 0, lastError: null },
        });

        const boss = getBoss();
        await Promise.all(
          failed.map((p: { id: string }) =>
            boss.send(
              "photo-resize",
              { photoId: p.id },
              {
                singletonKey: p.id,
                retryLimit: env.PROCESS_MAX_ATTEMPTS - 1,
                retryDelay: 10,
                retryBackoff: true,
              },
            ),
          ),
        );

        return { success: true as const, requeued: res.count };
      }),

      rename: adminOs.events.photos.rename.use(requireOwner).handler(async ({ input, context }) => {
        const res = await prisma.photo.updateMany({
          where: { id: { in: input.photoIds }, eventId: context.event.id },
          data: { photographerName: input.photographerName.trim() || null },
        });
        return { success: true as const, updated: res.count };
      }),

      deleteMany: adminOs.events.photos.deleteMany
        .use(requireOwner)
        .handler(async ({ input, context }) => {
          const photos = await prisma.photo.findMany({
            where: { id: { in: input.photoIds }, eventId: context.event.id },
            select: { id: true, originalKey: true, displayKey: true, thumbKey: true },
          });

          await Promise.all(
            photos.flatMap((p: { originalKey: string; displayKey: string; thumbKey: string }) =>
              [p.originalKey, p.displayKey, p.thumbKey]
                .filter(Boolean)
                .map((key) => deleteS3Object(key).catch(() => {})),
            ),
          );

          const ids = photos.map((p: { id: string }) => p.id);
          await prisma.photo.deleteMany({ where: { id: { in: ids }, eventId: context.event.id } });
          await staleArchivePartsForPhotos(context.event.id, ids);

          return { success: true as const, deleted: photos.length };
        }),

      delete: adminOs.events.photos.delete
        .use(requireOwner)
        .handler(async ({ input, context, errors }) => {
          const photo = await prisma.photo.findUnique({
            where: { id: input.photoId, eventId: context.event.id },
          });
          if (!photo) throw errors.NOT_FOUND({ message: "Photo not found" });

          await Promise.all(
            [photo.originalKey, photo.displayKey, photo.thumbKey]
              .filter(Boolean)
              .map((key) => deleteS3Object(key).catch(() => {})),
          );

          await prisma.photo.delete({ where: { id: photo.id } });
          await staleArchivePartsForPhotos(context.event.id, [photo.id]);

          return { success: true as const };
        }),
    },

    // The archive domain runs behind the Effect runtime — these handlers are
    // `runService` one-liners; retries and failure typing live in the service.
    download: {
      status: adminOs.events.download.status
        .use(
          rateLimit({
            key: (input: { id: string }) => `admin-download-status:${input.id}`,
            limit: 60,
            windowMs: 60_000,
          }),
        )
        .use(requireOwner)
        .handler(({ input }) =>
          runService(DownloadService, (s) => s.status(input.id, input.quality)),
        ),

      buildNow: adminOs.events.download.buildNow.use(requireOwner).handler(async ({ input }) => {
        await runService(DownloadService, (s) => s.buildNow(input.id, input.quality));
        return { success: true as const };
      }),

      rebuildAll: adminOs.events.download.rebuildAll
        .use(requireOwner)
        .handler(async ({ input }) => {
          await runService(DownloadService, (s) => s.rebuildAll(input.id, input.quality));
          return { success: true as const };
        }),

      cancel: adminOs.events.download.cancel.use(requireOwner).handler(async ({ input }) => {
        await runService(DownloadService, (s) => s.cancel(input.id, input.quality));
        return { success: true as const };
      }),
    },
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

    // Both archive variants in one round trip (partial availability: already
    // built parts are served while newer ones are still building).
    download: base.gallery.download
      .use(
        rateLimit({
          key: (input: { slug: string }) => `download-check:${input.slug}`,
          limit: 30,
          windowMs: 60_000,
        }),
      )
      .use(galleryOs)
      .handler(({ context }) =>
        runService(DownloadService, (s) =>
          s.guestPayload(context.galleryEvent.id, context.galleryEvent.slug),
        ),
      ),

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
