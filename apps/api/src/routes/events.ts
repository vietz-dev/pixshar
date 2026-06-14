import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { s3, deleteS3Object, getPresignedUrl } from "../lib/s3.js";
import { env } from "../lib/env.js";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { HonoVariables } from "../types.js";

const app = new Hono<{ Variables: HonoVariables }>();

const createSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  password: z.string().min(1),
});

app.get("/", requireAdmin, async (c) => {
  const events = await prisma.event.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { photos: true } },
    },
  });
  return c.json(events);
});

app.post("/", requireAdmin, zValidator("json", createSchema), async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user");

  const existing = await prisma.event.findUnique({ where: { slug: body.slug } });
  if (existing) {
    return c.json({ error: "Slug already exists" }, 409);
  }

  const event = await prisma.event.create({
    data: {
      name: body.name,
      slug: body.slug,
      description: body.description || null,
      passwordHash: body.password,
      createdById: user.id,
      status: "READY",
    },
  });

  return c.json(event, 201);
});

app.get("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const event = await prisma.event.findUnique({
    where: { id },
    include: { photos: { orderBy: { createdAt: "desc" } } },
  });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }

  const photosWithUrls = await Promise.all(
    event.photos.map(async (photo: typeof event.photos[0]) => ({
      ...photo,
      thumbUrl: photo.thumbKey ? await getPresignedUrl(photo.thumbKey, "get", 3600) : "",
      displayUrl: photo.displayKey ? await getPresignedUrl(photo.displayKey, "get", 3600) : "",
    }))
  );

  return c.json({ ...event, photos: photosWithUrls });
});

app.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const event = await prisma.event.findUnique({
    where: { id },
    include: { photos: true },
  });
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }

  // Delete all S3 objects under the event prefix
  try {
    const prefix = `${event.id}/`;
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: prefix,
      })
    );
    if (list.Contents) {
      for (const obj of list.Contents) {
        if (obj.Key) {
          await deleteS3Object(obj.Key);
        }
      }
    }
  } catch {
    // S3 cleanup failed, continue with DB delete
  }

  await prisma.event.delete({ where: { id } });
  return c.json({ success: true });
});

export default app;
