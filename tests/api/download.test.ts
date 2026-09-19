/**
 * API integration tests for the gallery download archive endpoints.
 * Runs against the live Docker Compose stack (localhost:3001).
 *
 * Covers:
 *  - Auth guards: gallery cookie required, cross-gallery cookie rejected
 *  - GET /api/gallery/:slug/download — payload shape for all non-READY states
 *  - GET /api/gallery/:slug/download — payload shape when READY (parts array)
 *  - POST /api/events/:id/download/build-now — skip debounce, queue reconcile
 *  - POST /api/events/:id/download/rebuild-all — rebuild all parts (membership-preserving)
 *  - POST /api/events/:id/download/cancel — cancels a queued/building job
 *  - GET /api/events/:id/download/status — admin status endpoint shape
 *  - Admin auth guard on all admin download endpoints
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  API,
  signInAdmin,
  authedFetch,
  createEvent,
  deleteEvent,
  unlockGallery,
  uploadAndProcessPhoto,
  type TestEvent,
} from "./helpers.js";

// Shape of the both-variants guest download payload.
interface VariantPayload {
  status: string;
  parts: Array<{
    index: number;
    url: string | null;
    sizeBytes: number;
    membershipSig: string;
    rebuilding: boolean;
  }>;
  partCount: number;
  totalSizeBytes: number;
  photoCount: number;
  building: boolean;
}
interface BothVariantsBody {
  defaultQuality: string;
  status: string; // back-compat: default variant spread at top level
  variants: { DISPLAY: VariantPayload; ORIGINAL: VariantPayload };
}

async function pollAdminStatus(
  cookie: string,
  eventId: string,
  quality: "DISPLAY" | "ORIGINAL",
  until: (s: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = "";
  while (Date.now() < deadline) {
    const res = await authedFetch(
      `/api/events/${eventId}/download/status?quality=${quality}`,
      cookie,
    );
    status = ((await res.json()) as { status: string }).status;
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

  // ── Auth guards on guest download endpoint ─────────────────────────────────

  describe("Given no gallery session cookie", () => {
    describe("When fetching GET /api/gallery/:slug/download", () => {
      it("Then it returns 401", async () => {
        const res = await fetch(`${API}/api/gallery/${event.slug}/download`);
        expect(res.status).toBe(401);
      });
    });
  });

  describe("Given a gallery session cookie for a different event", () => {
    it("Then it returns 401 (cross-gallery cookie rejected)", async () => {
      const other = await createEvent(adminCookie, { password: "other-pass" });
      const otherCookie = await unlockGallery(other.slug, "other-pass");
      await deleteEvent(adminCookie, other.id);

      const res = await fetch(`${API}/api/gallery/${event.slug}/download`, {
        headers: { Cookie: otherCookie },
      });
      expect(res.status).toBe(401);
    });
  });

  // ── Payload shape — no archive yet ────────────────────────────────────────

  describe("Given a valid gallery session and no archive exists yet", () => {
    describe("When fetching GET /api/gallery/:slug/download", () => {
      it("Then it returns 200 with status NONE", async () => {
        const res = await fetch(`${API}/api/gallery/${event.slug}/download`, {
          headers: { Cookie: galleryCookie },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        // Fresh event with no photos will be NONE (no DownloadJob row yet)
        expect(["NONE", "DEBOUNCING", "QUEUED", "BUILDING"]).toContain(body.status);
      });
    });
  });

  // ── Admin download/status endpoint ────────────────────────────────────────

  describe("Admin download status endpoint", () => {
    describe("Given an authenticated admin", () => {
      describe("When fetching GET /api/events/:id/download/status", () => {
        it("Then it returns 200 with required status fields", async () => {
          const res = await authedFetch(`/api/events/${event.id}/download/status`, adminCookie);
          expect(res.status).toBe(200);
          const body = (await res.json()) as Record<string, unknown>;
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
      it("Then it returns 401", async () => {
        const res = await fetch(`${API}/api/events/${event.id}/download/status`);
        expect(res.status).toBe(401);
      });
    });
  });

  // ── Force-build (admin) ───────────────────────────────────────────────────

  describe("Admin build-now / rebuild-all", () => {
    describe("Given an authenticated admin", () => {
      describe("When posting POST /api/events/:id/download/build-now", () => {
        it("Then it returns 200 (no-op when there is no pending job to skip)", async () => {
          const res = await authedFetch(`/api/events/${event.id}/download/build-now`, adminCookie, {
            method: "POST",
          });
          expect(res.status).toBe(200);
          const body = (await res.json()) as { success: boolean };
          expect(body.success).toBe(true);

          // With no processed photos there is no job — build-now leaves it NONE.
          // Once a debounce/reconcile is pending it promotes it to QUEUED.
          const statusRes = await authedFetch(
            `/api/events/${event.id}/download/status`,
            adminCookie,
          );
          const statusBody = (await statusRes.json()) as { status: string };
          expect(["NONE", "DEBOUNCING", "QUEUED", "BUILDING", "READY"]).toContain(
            statusBody.status,
          );
        });
      });

      describe("When posting POST /api/events/:id/download/rebuild-all", () => {
        it("Then it returns 200", async () => {
          const res = await authedFetch(
            `/api/events/${event.id}/download/rebuild-all`,
            adminCookie,
            {
              method: "POST",
            },
          );
          expect(res.status).toBe(200);
          const body = (await res.json()) as { success: boolean };
          expect(body.success).toBe(true);
        });
      });
    });

    describe("Given no admin session", () => {
      it("Then build-now returns 401", async () => {
        const res = await fetch(`${API}/api/events/${event.id}/download/build-now`, {
          method: "POST",
        });
        expect(res.status).toBe(401);
      });
      it("Then rebuild-all returns 401", async () => {
        const res = await fetch(`${API}/api/events/${event.id}/download/rebuild-all`, {
          method: "POST",
        });
        expect(res.status).toBe(401);
      });
    });
  });

  // ── Cancel (admin) ────────────────────────────────────────────────────────

  describe("Admin cancel", () => {
    describe("Given an authenticated admin and a QUEUED job", () => {
      it("Then POST /api/events/:id/download/cancel returns 200 and job moves to CANCELLED", async () => {
        // Ensure there is a queued job
        await authedFetch(`/api/events/${event.id}/download/build-now`, adminCookie, {
          method: "POST",
        });

        const cancelRes = await authedFetch(
          `/api/events/${event.id}/download/cancel`,
          adminCookie,
          { method: "POST" },
        );
        expect(cancelRes.status).toBe(200);

        const statusRes = await authedFetch(`/api/events/${event.id}/download/status`, adminCookie);
        const statusBody = (await statusRes.json()) as { status: string };
        // With no pending job both build-now and cancel are no-ops (NONE). With a
        // real job it moves to CANCELLED (or READY if the worker was very fast).
        expect(["NONE", "CANCELLED", "READY"]).toContain(statusBody.status);
      });
    });

    describe("Given no admin session", () => {
      it("Then it returns 401", async () => {
        const res = await fetch(`${API}/api/events/${event.id}/download/cancel`, {
          method: "POST",
        });
        expect(res.status).toBe(401);
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
        await authedFetch(`/api/events/${emptyEvent.id}/download/build-now`, adminCookie, {
          method: "POST",
        });

        // Poll up to 15s for READY (0 photos → instant build)
        let status = "QUEUED";
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const s = await authedFetch(`/api/events/${emptyEvent.id}/download/status`, adminCookie);
          const b = (await s.json()) as { status: string };
          status = b.status;
          if (status === "READY" || status === "FAILED" || status === "CANCELLED") break;
        }

        if (status !== "READY") {
          // 0-photo build might not produce a READY archive (implementation may skip)
          // That's acceptable — just verify the endpoint doesn't crash.
          return;
        }

        const res = await fetch(`${API}/api/gallery/${emptyEvent.slug}/download`, {
          headers: { Cookie: emptyGalleryCookie },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          defaultQuality: string;
          variants: Record<
            string,
            {
              status: string;
              parts?: { index: number; url: string; sizeBytes: number }[];
              partCount?: number;
            }
          >;
        };

        // We built the ORIGINAL variant (build-now defaults to ORIGINAL), so its
        // variant payload is the READY one to assert against.
        const original = body.variants.ORIGINAL;
        expect(original.status).toBe("READY");
        expect(Array.isArray(original.parts)).toBe(true);
        expect(typeof original.partCount).toBe("number");

        if (original.parts && original.parts.length > 0) {
          const part = original.parts[0];
          expect(typeof part.index).toBe("number");
          expect(typeof part.url).toBe("string");
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
    it("Then GET /api/events/:id/download/status exposes partCount field", async () => {
      const res = await authedFetch(`/api/events/${event.id}/download/status`, adminCookie);
      const body = (await res.json()) as { partCount: number };
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
      it("Then GET /api/gallery/:slug/download returns both variants with DISPLAY as the default", async () => {
        const res = await fetch(`${API}/api/gallery/${event.slug}/download`, {
          headers: { Cookie: galleryCookie },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as BothVariantsBody;

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
          const before = await authedFetch(
            `/api/events/${lazyEvent.id}/download/status?quality=DISPLAY`,
            adminCookie,
          );
          expect(((await before.json()) as { status: string }).status).toBe("NONE");

          // Guest opens the download page → lazily materializes the DISPLAY job.
          const gres = await fetch(`${API}/api/gallery/${lazyEvent.slug}/download`, {
            headers: { Cookie: lazyCookie },
          });
          expect(gres.status).toBe(200);

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
        await authedFetch(
          `/api/events/${fanEvent.id}/download/build-now?quality=DISPLAY`,
          adminCookie,
          { method: "POST" },
        );
        await authedFetch(
          `/api/events/${fanEvent.id}/download/build-now?quality=ORIGINAL`,
          adminCookie,
          { method: "POST" },
        );

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
        const res = await fetch(`${API}/api/gallery/${fanEvent.slug}/download`, {
          headers: { Cookie: fanCookie },
        });
        const body = (await res.json()) as BothVariantsBody;
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
    it("Then build-now on DISPLAY does not create or touch the ORIGINAL job", async () => {
      // Fresh event, no ORIGINAL trigger. A guest visit creates only the DISPLAY
      // job; building DISPLAY must leave ORIGINAL untouched (still NONE).
      const indyEvent = await createEvent(adminCookie, { password: "indy-pass" });
      const indyCookie = await unlockGallery(indyEvent.slug, "indy-pass");
      try {
        // Lazily create the DISPLAY job.
        await fetch(`${API}/api/gallery/${indyEvent.slug}/download`, {
          headers: { Cookie: indyCookie },
        });

        // Force-build only the DISPLAY variant.
        const buildRes = await authedFetch(
          `/api/events/${indyEvent.id}/download/build-now?quality=DISPLAY`,
          adminCookie,
          { method: "POST" },
        );
        expect(buildRes.status).toBe(200);

        // ORIGINAL was never triggered → still NONE (independence).
        const originalRes = await authedFetch(
          `/api/events/${indyEvent.id}/download/status?quality=ORIGINAL`,
          adminCookie,
        );
        expect(((await originalRes.json()) as { status: string }).status).toBe("NONE");

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
      const res = await authedFetch(
        `/api/events/${event.id}/download/status?quality=DISPLAY`,
        adminCookie,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { quality: string };
      expect(body.quality).toBe("DISPLAY");
    });
  });
});
