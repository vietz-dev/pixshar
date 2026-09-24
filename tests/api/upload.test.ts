import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  signInAdmin,
  createEvent,
  deleteEvent,
  unlockGallery,
  rpc,
  API,
  type TestEvent,
} from "./helpers.js";

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
    "hex",
  );
}

function fileMeta(bytes: Buffer, fileName: string) {
  return {
    fileName,
    ext: "jpg",
    contentType: "image/jpeg" as const,
    size: bytes.length,
    fileHash: sha256(bytes),
  };
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
    describe("When calling upload.init", () => {
      it("Then it returns presigned PUT URLs for each file", async () => {
        const meta = fileMeta(tinyJpeg(), "test-photo.jpg");

        const { photos } = await rpc(adminCookie).upload.init({
          eventId: event.id,
          files: [meta],
        });

        expect(photos).toHaveLength(1);
        expect(photos[0].fileHash).toBe(meta.fileHash);
        expect(photos[0].uploadUrl).toMatch(/^http/);
      });
    });
  });

  describe("Given the same file hash uploaded twice (deduplication)", () => {
    describe("When initialising the upload again", () => {
      it("Then the second response resumes or marks the photo a duplicate", async () => {
        const files = [fileMeta(tinyJpeg(), "dup.jpg")];

        await rpc(adminCookie).upload.init({ eventId: event.id, files });
        const { photos } = await rpc(adminCookie).upload.init({ eventId: event.id, files });

        // PENDING row → resume (not flagged duplicate yet); PROCESSED → duplicate.
        expect(photos).toHaveLength(1);
        expect(photos[0].duplicate || photos[0].uploadUrl).toBeTruthy();
      });
    });
  });

  describe("Given a file that violates the contract's limits", () => {
    describe("When calling upload.init", () => {
      it("Then it is rejected as BAD_REQUEST, not a raw ZodError", async () => {
        const meta = fileMeta(tinyJpeg(), "too-big.jpg");

        await expect(
          rpc(adminCookie).upload.init({
            eventId: event.id,
            files: [{ ...meta, size: 51 * 1024 * 1024 }],
          }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });

        const res = await fetch(`${API}/api/rpc/upload/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: adminCookie },
          body: JSON.stringify({
            json: { eventId: event.id, files: [{ ...meta, contentType: "image/gif" }] },
          }),
        });
        expect(res.status).toBe(400);
      });
    });
  });

  describe("Given a guest with a valid gallery session", () => {
    describe("When calling gallery.upload.init", () => {
      it("Then it returns a presigned URL", async () => {
        const galleryCookie = await unlockGallery(event.slug, "upload-pass");

        const { photos } = await rpc(galleryCookie).gallery.upload.init({
          slug: event.slug,
          photographerName: "Guest Tester",
          files: [fileMeta(tinyJpeg(), "guest-photo.jpg")],
        });

        expect(photos).toHaveLength(1);
      });
    });
  });

  describe("Given an unauthenticated request", () => {
    describe("When calling upload.init", () => {
      it("Then it fails with UNAUTHORIZED", async () => {
        await expect(
          rpc().upload.init({ eventId: event.id, files: [fileMeta(tinyJpeg(), "nope.jpg")] }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      });
    });

    describe("When calling gallery.upload.init without a gallery cookie", () => {
      it("Then it fails with UNAUTHORIZED", async () => {
        await expect(
          rpc().gallery.upload.init({
            slug: event.slug,
            files: [fileMeta(tinyJpeg(), "nope.jpg")],
          }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      });
    });
  });

  // ─── Status poll ─────────────────────────────────────────────────────────────

  describe("Given an event with no photos", () => {
    describe("When calling upload.status", () => {
      it("Then all counts are zero", async () => {
        const fresh = await createEvent(adminCookie, { password: "fresh-pass" });

        const status = await rpc(adminCookie).upload.status({ eventId: fresh.id });
        expect(status.total).toBe(0);

        await deleteEvent(adminCookie, fresh.id);
      });
    });
  });
});
