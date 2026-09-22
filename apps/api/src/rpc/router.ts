import { prisma } from "../lib/prisma.js";
import { base } from "./base.js";

export const router = base.router({
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
