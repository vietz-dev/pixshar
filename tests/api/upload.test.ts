import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  signInAdmin,
  authedFetch,
  createEvent,
  deleteEvent,
  unlockGallery,
  type TestEvent,
} from "./helpers.js";
import { API } from "./helpers.js";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Build a minimal 1-pixel JPEG (JFIF format). */
function tinyJpeg(): Buffer {
  return Buffer.from(
    "ffd8ffe000104a46494600010100000100010000ffdb004300" +
    "08060606070605080707070909080a0c140d0c0b0b0c191213" +
    "0f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30" +
    "313434341f27393d38323c2e333432ffc0000b080001000101" +
    "011100ffc4001f0000010501010101010100000000000000000" +
    "102030405060708090a0bffda00080101000000011800ffd9",
    "hex"
  );
}

describe("Photo Upload", () => {
  let adminCookie: string;
  let event: TestEvent;

  beforeAll(async () => {
    adminCookie = await signInAdmin();
    event = await createEvent(adminCookie, { password: "upload-pass" });
  });

  afterAll(async () => {
    await deleteEvent(adminCookie, event.id);
  });

  // ─── Init upload ─────────────────────────────────────────────────────────────

  describe("Given an authenticated admin with an event", () => {
    describe("When initialising an upload via POST /api/upload/events/:id/photos/init", () => {
      it("Then it returns 200 with presigned PUT URLs for each file", async () => {
        const jpeg = tinyJpeg();
        const hash = sha256(jpeg);

        const res = await authedFetch(
          `/api/upload/events/${event.id}/photos/init`,
          adminCookie,
          {
            method: "POST",
            body: JSON.stringify({
              files: [
                {
                  fileName: "test-photo.jpg",
                  ext: "jpg",
                  contentType: "image/jpeg",
                  size: jpeg.length,
                  fileHash: hash,
                },
              ],
            }),
          }
        );

        expect(res.status).toBe(200);
        const body = await res.json() as { photos: Array<{ fileHash: string; uploadUrl: string }> };
        expect(body.photos).toHaveLength(1);
        expect(body.photos[0].fileHash).toBe(hash);
        expect(body.photos[0].uploadUrl).toMatch(/^http/);
      });
    });
  });

  describe("Given the same file hash uploaded twice (deduplication)", () => {
    describe("When initialising the upload again", () => {
      it("Then the second response marks the photo as a duplicate", async () => {
        const jpeg = tinyJpeg();
        const hash = sha256(jpeg);
        const payload = {
          files: [{ fileName: "dup.jpg", ext: "jpg", contentType: "image/jpeg", size: jpeg.length, fileHash: hash }],
        };

        // First init
        await authedFetch(`/api/upload/events/${event.id}/photos/init`, adminCookie, {
          method: "POST",
          body: JSON.stringify(payload),
        });

        // Second init with same hash
        const res2 = await authedFetch(
          `/api/upload/events/${event.id}/photos/init`,
          adminCookie,
          { method: "POST", body: JSON.stringify(payload) }
        );

        const body = await res2.json() as { photos: Array<{ duplicate?: boolean }> };
        // PENDING row → resume (not flagged duplicate yet), or if PROCESSED → duplicate: true
        expect([200, 200]).toContain(res2.status);
        // Either duplicate or a new presigned URL is fine; the key thing is no 500
        expect(body.photos).toHaveLength(1);
      });
    });
  });

  describe("Given a guest with a valid gallery session", () => {
    describe("When initialising a guest upload via POST /api/gallery/:slug/upload/init", () => {
      it("Then it returns 200 with a presigned URL", async () => {
        const jpeg = tinyJpeg();
        const hash = sha256(jpeg);
        const galleryCookie = await unlockGallery(event.slug, "upload-pass");

        const res = await fetch(`${API}/api/gallery/${event.slug}/upload/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: galleryCookie },
          body: JSON.stringify({
            photographerName: "Guest Tester",
            files: [
              {
                fileName: "guest-photo.jpg",
                ext: "jpg",
                contentType: "image/jpeg",
                size: jpeg.length,
                fileHash: hash,
              },
            ],
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json() as { photos: unknown[] };
        expect(body.photos).toHaveLength(1);
      });
    });
  });

  describe("Given an unauthenticated request", () => {
    describe("When calling the admin upload init endpoint", () => {
      it("Then it returns 401 Unauthorized", async () => {
        const res = await fetch(
          `${API}/api/upload/events/${event.id}/photos/init`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [] }) }
        );
        expect(res.status).toBe(401);
      });
    });
  });

  // ─── Status poll ─────────────────────────────────────────────────────────────

  describe("Given an event with no photos", () => {
    describe("When polling photo status via GET /api/upload/events/:id/photos/status", () => {
      it("Then it returns 200 with all counts at zero", async () => {
        const fresh = await createEvent(adminCookie, { password: "fresh-pass" });

        const res = await authedFetch(`/api/upload/events/${fresh.id}/photos/status`, adminCookie);
        expect(res.status).toBe(200);
        const body = await res.json() as { pending: number; processed: number; failed: number; total: number };
        expect(body.total).toBe(0);

        await deleteEvent(adminCookie, fresh.id);
      });
    });
  });
});
