import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { env } from "../lib/env.js";
import { encryptPassword, decryptPassword } from "../lib/crypto.js";
import { hashPassword } from "../lib/hash.js";
import { prisma } from "../lib/prisma.js";
import { deleteS3Object, getPresignedUrl, s3 } from "../lib/s3.js";
import { base } from "./base.js";
import { adminOs, rateLimit, requireOwner } from "./middleware.js";

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
  },
});
