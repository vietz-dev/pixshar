import { events } from "./events.js";
import { gallery } from "./gallery.js";

export * from "./events.js";
export * from "./gallery.js";

export const contract = {
  events,
  gallery,
};

export type Contract = typeof contract;
