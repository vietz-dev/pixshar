import { oc } from "@orpc/contract";
import { z } from "zod";
import { events } from "./events.js";

export * from "./events.js";

/** Public event info shown on the gallery password gate. */
export const galleryInfo = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});
export type GalleryInfo = z.infer<typeof galleryInfo>;

export const contract = {
  events,
  gallery: {
    info: oc
      .input(z.object({ slug: z.string() }))
      .errors({ NOT_FOUND: {} })
      .output(galleryInfo),
  },
};

export type Contract = typeof contract;
