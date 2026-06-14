import type { Event } from "@prisma/client";

export interface UserContext {
  id: string;
  email: string;
  name: string | null;
  image?: string | null;
}

export interface HonoVariables {
  user: UserContext;
  galleryEvent: Event;
}
