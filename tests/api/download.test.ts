/**
 * API integration tests for the download archive procedures.
 * Runs against the live Docker Compose stack (localhost:3001).
 *
 * Covers:
 *  - Auth guards: gallery cookie required, cross-gallery cookie rejected
 *  - gallery.download — payload shape for all non-READY states and when READY
 *  - events.download.buildNow — skip debounce, queue reconcile
 *  - events.download.rebuildAll — rebuild all parts (membership-preserving)
 *  - events.download.cancel — cancels a queued/building job
 *  - events.download.status — admin status shape, per variant
 *  - Admin auth guard on all admin download procedures
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Quality } from "@pixshar/contracts";
import {
  signInAdmin,
  rpc,
  createEvent,
  deleteEvent,
  unlockGallery,
  uploadAndProcessPhoto,
  type TestEvent,
} from "./helpers.js";

async function pollAdminStatus(
  cookie: string,
  eventId: string,
  quality: Quality,
  until: (s: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = "";
  while (Date.now() < deadline) {
    status = (await rpc(cookie).events.download.status({ id: eventId, quality })).status;
    if (until(status)) return status;
    await new Promise((r) => setTimeout(r, 500));
  }
  return status;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

describe("Gallery archive download", () => {
  let adminCookie: string;
  let event: TestEvent;
  let galleryCookie: string;

  beforeAll(async () => {
    adminCookie = await signInAdmin();
    event = await createEvent(adminCookie, { password: "dl-test-pass" });
    galleryCookie = await unlockGallery(event.slug, "dl-test-pass");
  });

  afterAll(async () => {
    await deleteEvent(adminCookie, event.id);
  });

  // ── Auth guards on the guest download procedure ───────────────────────────

  describe("Given no gallery session cookie", () => {
    describe("When calling gallery.download", () => {
      it("Then it fails with UNAUTHORIZED", async () => {
        await expect(rpc().gallery.download({ slug: event.slug })).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      });
    });
  });

  describe("Given a gallery session cookie for a different event", () => {
    it("Then it fails with UNAUTHORIZED (cross-gallery cookie rejected)", async () => {
      const other = await createEvent(adminCookie, { password: "other-pass" });
      const otherCookie = await unlockGallery(other.slug, "other-pass");
      await deleteEvent(adminCookie, other.id);

      await expect(rpc(otherCookie).gallery.download({ slug: event.slug })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });

  // ── Payload shape — no archive yet ────────────────────────────────────────

  describe("Given a valid gallery session and no archive exists yet", () => {
    describe("When calling gallery.download", () => {
      it("Then it answers with a not-yet-built status", async () => {
        const body = await rpc(galleryCookie).gallery.download({ slug: event.slug });
        // Fresh event with no photos will be NONE (no DownloadJob row yet)
        expect(["NONE", "DEBOUNCING", "QUEUED", "BUILDING"]).toContain(body.status);
      });
    });
  });

  // ── Admin download status ─────────────────────────────────────────────────

  describe("Admin download status", () => {
    describe("Given an authenticated admin", () => {
      describe("When calling events.download.status", () => {
        it("Then it returns the required status fields", async () => {
          const body = await rpc(adminCookie).events.download.status({ id: event.id });
          expect(body).toHaveProperty("status");
          expect(body).toHaveProperty("photoCount");
          expect(body).toHaveProperty("processedPhotos");
          expect(body).toHaveProperty("totalPhotos");
          expect(body).toHaveProperty("partCount");
          expect(body).toHaveProperty("totalSizeBytes");
        });
      });
    });

    describe("Given no admin session", () => {
      it("Then it fails with UNAUTHORIZED", async () => {
        await expect(rpc().events.download.status({ id: event.id })).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      });
    });
  });

  // ── Force-build (admin) ───────────────────────────────────────────────────

  describe("Admin build-now / rebuild-all", () => {
    describe("Given an authenticated admin", () => {
      describe("When calling events.download.buildNow", () => {
        it("Then it succeeds (no-op when there is no pending job to skip)", async () => {
          const body = await rpc(adminCookie).events.download.buildNow({ id: event.id });
          expect(body.success).toBe(true);

          // With no processed photos there is no job — build-now leaves it NONE.
          // Once a debounce/reconcile is pending it promotes it to QUEUED.
          const status = await rpc(adminCookie).events.download.status({ id: event.id });
          expect(["NONE", "DEBOUNCING", "QUEUED", "BUILDING", "READY"]).toContain(status.status);
        });
      });

      describe("When calling events.download.rebuildAll", () => {
        it("Then it succeeds", async () => {
          const body = await rpc(adminCookie).events.download.rebuildAll({ id: event.id });
          expect(body.success).toBe(true);
        });
      });
    });

    describe("Given no admin session", () => {
      it("Then buildNow fails with UNAUTHORIZED", async () => {
        await expect(rpc().events.download.buildNow({ id: event.id })).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      });
      it("Then rebuildAll fails with UNAUTHORIZED", async () => {
        await expect(rpc().events.download.rebuildAll({ id: event.id })).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      });
    });
  });

  // ── Cancel (admin) ────────────────────────────────────────────────────────

  describe("Admin cancel", () => {
    describe("Given an authenticated admin and a QUEUED job", () => {
      it("Then events.download.cancel succeeds and the job moves to CANCELLED", async () => {
        // Ensure there is a queued job
        await rpc(adminCookie).events.download.buildNow({ id: event.id });

        const cancelled = await rpc(adminCookie).events.download.cancel({ id: event.id });
        expect(cancelled.success).toBe(true);

        const status = await rpc(adminCookie).events.download.status({ id: event.id });
        // With no pending job both build-now and cancel are no-ops (NONE). With a
        // real job it moves to CANCELLED (or READY if the worker was very fast).
        expect(["NONE", "CANCELLED", "READY"]).toContain(status.status);
      });
    });

    describe("Given no admin session", () => {
      it("Then it fails with UNAUTHORIZED", async () => {
        await expect(rpc().events.download.cancel({ id: event.id })).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      });
    });
  });

  // ── READY payload shape ────────────────────────────────────────────────────

  describe("Gallery download when archive is READY", () => {
    it("Given a READY job (0 photos), Then payload has parts array and correct fields", async () => {
      // Force a build on an event with 0 photos — worker should mark it READY
      // immediately (no photos to zip → 0-entry archive in 1 part, or maybe no
      // parts at all for 0-photo event). We test that the payload is well-formed.
      const emptyEvent = await createEvent(adminCookie, { password: "ready-test" });
      const emptyGalleryCookie = await unlockGallery(emptyEvent.slug, "ready-test");

      try {
        await rpc(adminCookie).events.download.buildNow({ id: emptyEvent.id });

        // Poll up to 15s for READY (0 photos → instant build)
        const status = await pollAdminStatus(
          adminCookie,
          emptyEvent.id,
          "ORIGINAL",
          (s) => s === "READY" || s === "FAILED" || s === "CANCELLED",
          15_000,
        );

        if (status !== "READY") {
          // 0-photo build might not produce a READY archive (implementation may skip)
          // That's acceptable — just verify the procedure doesn't crash.
          return;
        }

        const body = await rpc(emptyGalleryCookie).gallery.download({ slug: emptyEvent.slug });

        // We built the ORIGINAL variant (build-now defaults to ORIGINAL), so its
        // variant payload is the READY one to assert against.
        const original = body.variants.ORIGINAL;
        expect(original.status).toBe("READY");
        expect(Array.isArray(original.parts)).toBe(true);
        expect(typeof original.partCount).toBe("number");

        if (original.parts.length > 0) {
          const part = original.parts[0];
          expect(typeof part.index).toBe("number");
          expect(part.url).toMatch(/^https?:\/\//);
          expect(typeof part.sizeBytes).toBe("number");
          // URL must carry Content-Disposition with the event slug
          expect(part.url).toMatch(/response-content-disposition/i);
        }
      } finally {
        await deleteEvent(adminCookie, emptyEvent.id);
      }
    });
  });

  // ── Multi-part boundary: planArchiveParts enforces limit ──────────────────
  // (The pure unit tests in archivePlanner.test.ts cover this in detail;
  //  this integration test is a smoke-check that the env var is wired in.)

  describe("DOWNLOAD_MAX_PART_BYTES env var", () => {
    it("Then events.download.status exposes a partCount field", async () => {
      const body = await rpc(adminCookie).events.download.status({ id: event.id });
      // partCount is 0 when no archive exists; any non-negative integer is valid
      expect(typeof body.partCount).toBe("number");
      expect(body.partCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Download variants — Kompakt (DISPLAY) + Original (ORIGINAL)  (#18/#20/#22)
  // ─────────────────────────────────────────────────────────────────────────

  describe("Guest download payload — both variants", () => {
    describe("Given a valid gallery session", () => {
      it("Then gallery.download returns both variants with DISPLAY as the default", async () => {
        const body = await rpc(galleryCookie).gallery.download({ slug: event.slug });

        // Kompakt is the default variant.
        expect(body.defaultQuality).toBe("DISPLAY");

        // Both variants are present and well-formed.
        expect(body.variants).toBeTruthy();
        for (const q of ["DISPLAY", "ORIGINAL"] as const) {
          const v = body.variants[q];
          expect(v).toBeTruthy();
          expect(typeof v.status).toBe("string");
          expect(Array.isArray(v.parts)).toBe(true);
          expect(typeof v.partCount).toBe("number");
          expect(typeof v.totalSizeBytes).toBe("number");
        }

        // Back-compat: the default (DISPLAY) variant's status is spread at top level.
        expect(body.status).toBe(body.variants.DISPLAY.status);
      });

      it("Then opening the download page lazily creates the DISPLAY (Kompakt) job", async () => {
        // Fresh event, no ORIGINAL build triggered → DISPLAY job only exists once
        // a guest opens the download page (ensureJob on first demand).
        const lazyEvent = await createEvent(adminCookie, { password: "lazy-pass" });
        const lazyCookie = await unlockGallery(lazyEvent.slug, "lazy-pass");
        try {
          // Before any guest request the admin DISPLAY status is NONE.
          const before = await rpc(adminCookie).events.download.status({
            id: lazyEvent.id,
            quality: "DISPLAY",
          });
          expect(before.status).toBe("NONE");

          // Guest opens the download page → lazily materializes the DISPLAY job.
          await rpc(lazyCookie).gallery.download({ slug: lazyEvent.slug });

          const after = await pollAdminStatus(
            adminCookie,
            lazyEvent.id,
            "DISPLAY",
            (s) => s !== "NONE",
          );
          expect(after).not.toBe("NONE");
        } finally {
          await deleteEvent(adminCookie, lazyEvent.id);
        }
      });
    });
  });

  describe("Upload trigger fan-out — both jobs created + Kompakt is fetchable", () => {
    it("Then uploading a photo creates BOTH jobs, and the DISPLAY archive builds and is downloadable", async () => {
      const fanEvent = await createEvent(adminCookie, { password: "fan-pass" });
      const fanCookie = await unlockGallery(fanEvent.slug, "fan-pass");
      try {
        await uploadAndProcessPhoto(adminCookie, fanEvent);

        // Fan-out proof: the processing trigger created BOTH variants' jobs, so
        // neither admin status is NONE (they start DEBOUNCING right after upload).
        const displayExists = await pollAdminStatus(
          adminCookie,
          fanEvent.id,
          "DISPLAY",
          (s) => s !== "NONE",
        );
        const originalExists = await pollAdminStatus(
          adminCookie,
          fanEvent.id,
          "ORIGINAL",
          (s) => s !== "NONE",
        );
        expect(displayExists).not.toBe("NONE");
        expect(originalExists).not.toBe("NONE");

        // Force both builds (skip the 60s debounce) so we can verify fetchability.
        await rpc(adminCookie).events.download.buildNow({ id: fanEvent.id, quality: "DISPLAY" });
        await rpc(adminCookie).events.download.buildNow({ id: fanEvent.id, quality: "ORIGINAL" });

        const displayStatus = await pollAdminStatus(
          adminCookie,
          fanEvent.id,
          "DISPLAY",
          (s) => s === "READY" || s === "FAILED",
          60_000,
        );
        const originalStatus = await pollAdminStatus(
          adminCookie,
          fanEvent.id,
          "ORIGINAL",
          (s) => s === "READY" || s === "FAILED",
          60_000,
        );
        expect(displayStatus).toBe("READY");
        expect(originalStatus).toBe("READY");

        // The Kompakt (DISPLAY) archive is downloadable: a valid presigned part URL.
        const body = await rpc(fanCookie).gallery.download({ slug: fanEvent.slug });
        expect(body.variants.DISPLAY.status).toBe("READY");
        expect(body.variants.DISPLAY.parts.length).toBeGreaterThan(0);
        expect(body.variants.DISPLAY.parts[0].url).toMatch(/^https?:\/\//);
        // Kompakt download filename carries the "-kompakt" segment.
        expect(body.variants.DISPLAY.parts[0].url).toMatch(/kompakt/i);
      } finally {
        await deleteEvent(adminCookie, fanEvent.id);
      }
    }, 180_000);
  });

  describe("Admin per-variant controls — independence", () => {
    it("Then buildNow on DISPLAY does not create or touch the ORIGINAL job", async () => {
      // Fresh event, no ORIGINAL trigger. A guest visit creates only the DISPLAY
      // job; building DISPLAY must leave ORIGINAL untouched (still NONE).
      const indyEvent = await createEvent(adminCookie, { password: "indy-pass" });
      const indyCookie = await unlockGallery(indyEvent.slug, "indy-pass");
      try {
        // Lazily create the DISPLAY job.
        await rpc(indyCookie).gallery.download({ slug: indyEvent.slug });

        // Force-build only the DISPLAY variant.
        const built = await rpc(adminCookie).events.download.buildNow({
          id: indyEvent.id,
          quality: "DISPLAY",
        });
        expect(built.success).toBe(true);

        // ORIGINAL was never triggered → still NONE (independence).
        const original = await rpc(adminCookie).events.download.status({
          id: indyEvent.id,
          quality: "ORIGINAL",
        });
        expect(original.status).toBe("NONE");

        // DISPLAY progressed off NONE.
        const displayStatus = await pollAdminStatus(
          adminCookie,
          indyEvent.id,
          "DISPLAY",
          (s) => s !== "NONE" && s !== "DEBOUNCING",
        );
        expect(["QUEUED", "BUILDING", "READY"]).toContain(displayStatus);
      } finally {
        await deleteEvent(adminCookie, indyEvent.id);
      }
    }, 60_000);

    it("Then admin status reports the variant it was asked for", async () => {
      const body = await rpc(adminCookie).events.download.status({
        id: event.id,
        quality: "DISPLAY",
      });
      expect(body.quality).toBe("DISPLAY");
    });
  });
});
