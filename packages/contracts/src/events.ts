import { oc } from "@orpc/contract";
import { z } from "zod";

/** One row of the admin event list. */
export const eventSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  createdAt: z.date(),
  _count: z.object({ photos: z.number() }),
});
export type EventSummary = z.infer<typeof eventSummary>;

/** A photo as the admin sees it — S3 keys plus presigned URLs, never bytes. */
export const adminPhoto = z.object({
  id: z.string(),
  photographerName: z.string().nullable(),
  originalKey: z.string(),
  displayKey: z.string(),
  thumbKey: z.string(),
  thumbUrl: z.string(),
  displayUrl: z.string(),
  status: z.string(),
  uploadedBy: z.string(),
  createdAt: z.date(),
  placeholderDataUrl: z.string().nullable(),
});
export type AdminPhoto = z.infer<typeof adminPhoto>;

/** The admin event detail page payload — includes the decrypted password. */
export const eventDetail = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  createdAt: z.date(),
  password: z.string().nullable(),
  photos: z.array(adminPhoto),
});
export type EventDetail = z.infer<typeof eventDetail>;

const success = z.object({ success: z.literal(true) });

export const events = {
  list: oc
    .input(z.object({}).optional())
    .errors({ TOO_MANY_REQUESTS: {} })
    .output(z.array(eventSummary)),

  create: oc
    .input(
      z.object({
        name: z.string().min(1).max(200),
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/),
        description: z.string().max(1000).optional(),
        password: z.string().min(1).max(128),
      }),
    )
    .errors({ CONFLICT: {}, TOO_MANY_REQUESTS: {} })
    .output(eventSummary.omit({ _count: true })),

  get: oc
    .input(z.object({ id: z.string() }))
    .errors({ NOT_FOUND: {}, FORBIDDEN: {}, TOO_MANY_REQUESTS: {} })
    .output(eventDetail),

  setPassword: oc
    .input(z.object({ id: z.string(), password: z.string().min(1).max(128) }))
    .errors({ NOT_FOUND: {}, FORBIDDEN: {} })
    .output(success),

  delete: oc
    .input(z.object({ id: z.string() }))
    .errors({ NOT_FOUND: {}, FORBIDDEN: {} })
    .output(success),
};
