import { events } from "./events.js";
import { gallery } from "./gallery.js";
import { upload } from "./upload.js";

export * from "./download.js";
export * from "./events.js";
export * from "./gallery.js";
export * from "./upload.js";

export const contract = {
  events,
  gallery,
  upload,
};

export type Contract = typeof contract;
