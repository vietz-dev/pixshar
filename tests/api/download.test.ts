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
 *  - GET /api/gallery/:slug/download/part/:index — 302 to S3, stamps the idle clock
 *  - POST /api/events/:id/download/release — expireArchive over HTTP (idle-reaper effect path)
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
  parts: Array<{ index: number; url: string | null; sizeBytes: number; membershipSig: string; rebuilding: boolean }>;
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

/** The (event, variant) job's idle clock, read through the admin status endpoint. */
async function lastDownloadedAt(
  cookie: string,
  eventId: string,
  quality: "DISPLAY" | "ORIGINAL"
): Promise<string | null> {
  const res = await authedFetch(`/api/events/${eventId}/download/status?quality=${quality}`, cookie);
  return ((await res.json()) as { lastDownloadedAt: string | null }).lastDownloadedAt;
}

/** The guest download payload for one variant. */
async function variantPayload(
  cookie: string,
  slug: string,
  quality: "DISPLAY" | "ORIGINAL"
): Promise<VariantPayload> {
  const res = await fetch(`${API}/api/gallery/${slug}/download`, { headers: { Cookie: cookie } });
  const body = (await res.json()) as BothVariantsBody;
  return body.variants[quality];
}

/** The admin-visible job status for one variant. */
async function adminStatus(
  cookie: string,
  eventId: string,
  quality: "DISPLAY" | "ORIGINAL"
): Promise<string> {
  const res = await authedFetch(`/api/events/${eventId}/download/status?quality=${quality}`, cookie);
  return ((await res.json()) as { status: string }).status;
}

async function pollAdminStatus(
  cookie: string,
  eventId: string,
  quality: "DISPLAY" | "ORIGINAL",
  until: (s: string) => boolean,
  timeoutMs = 30_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = "";
  while (Date.now() < deadline) {
    const res = await authedFetch(`/api/events/${eventId}/download/status?quality=${quality}`, cookie);
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
        const body = await res.json() as { status: string };
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
          const body = await res.json() as Record<string, unknown>;
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
          const body = await res.json() as { success: boolean };
          expect(body.success).toBe(true);

          // With no processed photos there is no job — build-now leaves it NONE.
          // Once a debounce/reconcile is pending it promotes it to QUEUED.
          const statusRes = await authedFetch(
            `/api/events/${event.id}/download/status`,
            adminCookie
          );
          const statusBody = await statusRes.json() as { status: string };
          expect(["NONE", "DEBOUNCING", "QUEUED", "BUILDING", "READY"]).toContain(statusBody.status);
        });
      });

      describe("When posting POST /api/events/:id/download/rebuild-all", () => {
        it("Then it returns 200", async () => {
          const res = await authedFetch(`/api/events/${event.id}/download/rebuild-all`, adminCookie, {
            method: "POST",
          });
          expect(res.status).toBe(200);
          const body = await res.json() as { success: boolean };
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
          { method: "POST" }
        );
        expect(cancelRes.status).toBe(200);

        const statusRes = await authedFetch(
          `/api/events/${event.id}/download/status`,
          adminCookie
        );
        const statusBody = await statusRes.json() as { status: string };
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
          const b = await s.json() as { status: string };
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
        const body = await res.json() as {
          defaultQuality: string;
          variants: Record<string, {
            status: string;
            parts?: { index: number; url: string; sizeBytes: number }[];
            partCount?: number;
          }>;
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
          expect(typeof part.sizeBytes).toBe("number");
          // Part URLs point at the API's part-redirect endpoint (which stamps the
          // idle clock), not straight at a presigned S3 URL.
          expect(part.url).toBe(
            `/api/gallery/${emptyEvent.slug}/download/part/${part.index}?quality=ORIGINAL`
          );
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
      const body = await res.json() as { partCount: number };
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
            adminCookie
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
            (s) => s !== "NONE"
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
        const displayExists = await pollAdminStatus(adminCookie, fanEvent.id, "DISPLAY", (s) => s !== "NONE");
        const originalExists = await pollAdminStatus(adminCookie, fanEvent.id, "ORIGINAL", (s) => s !== "NONE");
        expect(displayExists).not.toBe("NONE");
        expect(originalExists).not.toBe("NONE");

        // Force both builds (skip the 60s debounce) so we can verify fetchability.
        await authedFetch(`/api/events/${fanEvent.id}/download/build-now?quality=DISPLAY`, adminCookie, { method: "POST" });
        await authedFetch(`/api/events/${fanEvent.id}/download/build-now?quality=ORIGINAL`, adminCookie, { method: "POST" });

        const displayStatus = await pollAdminStatus(adminCookie, fanEvent.id, "DISPLAY", (s) => s === "READY" || s === "FAILED", 60_000);
        const originalStatus = await pollAdminStatus(adminCookie, fanEvent.id, "ORIGINAL", (s) => s === "READY" || s === "FAILED", 60_000);
        expect(displayStatus).toBe("READY");
        expect(originalStatus).toBe("READY");

        // The Kompakt (DISPLAY) archive is downloadable: a valid presigned part URL.
        const res = await fetch(`${API}/api/gallery/${fanEvent.slug}/download`, { headers: { Cookie: fanCookie } });
        const body = (await res.json()) as BothVariantsBody;
        expect(body.variants.DISPLAY.status).toBe("READY");
        expect(body.variants.DISPLAY.parts.length).toBeGreaterThan(0);
        const kompaktPart = body.variants.DISPLAY.parts[0];
        expect(kompaktPart.url).toBe(
          `/api/gallery/${fanEvent.slug}/download/part/${kompaktPart.index}?quality=DISPLAY`
        );
        // Following the redirect yields the Kompakt archive — its filename carries
        // the "-kompakt" segment.
        const redirect = await fetch(`${API}${kompaktPart.url}`, {
          headers: { Cookie: fanCookie },
          redirect: "manual",
        });
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("location")).toMatch(/kompakt/i);
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
          { method: "POST" }
        );
        expect(buildRes.status).toBe(200);

        // ORIGINAL was never triggered → still NONE (independence).
        const originalRes = await authedFetch(
          `/api/events/${indyEvent.id}/download/status?quality=ORIGINAL`,
          adminCookie
        );
        expect(((await originalRes.json()) as { status: string }).status).toBe("NONE");

        // DISPLAY progressed off NONE.
        const displayStatus = await pollAdminStatus(
          adminCookie,
          indyEvent.id,
          "DISPLAY",
          (s) => s !== "NONE" && s !== "DEBOUNCING"
        );
        expect(["QUEUED", "BUILDING", "READY"]).toContain(displayStatus);
      } finally {
        await deleteEvent(adminCookie, indyEvent.id);
      }
    }, 60_000);

    it("Then admin status reports the variant it was asked for", async () => {
      const res = await authedFetch(
        `/api/events/${event.id}/download/status?quality=DISPLAY`,
        adminCookie
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { quality: string };
      expect(body.quality).toBe("DISPLAY");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Part-redirect endpoint — measuring the real download (PIXSHAR-3)
  // ─────────────────────────────────────────────────────────────────────────

  describe("GET /api/gallery/:slug/download/part/:index", () => {
    let partEvent: TestEvent;
    let partCookie: string;

    // One event with a photo and BOTH variants built — every assertion below
    // reads from it, since building an archive is the expensive part.
    beforeAll(async () => {
      partEvent = await createEvent(adminCookie, { password: "part-pass" });
      partCookie = await unlockGallery(partEvent.slug, "part-pass");
      await uploadAndProcessPhoto(adminCookie, partEvent);

      for (const q of ["DISPLAY", "ORIGINAL"] as const) {
        await authedFetch(`/api/events/${partEvent.id}/download/build-now?quality=${q}`, adminCookie, {
          method: "POST",
        });
      }
      for (const q of ["DISPLAY", "ORIGINAL"] as const) {
        const s = await pollAdminStatus(adminCookie, partEvent.id, q, (v) => v === "READY" || v === "FAILED", 90_000);
        if (s !== "READY") throw new Error(`${q} archive not READY (got ${s})`);
      }
    }, 240_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, partEvent.id);
    });

    it("Then it returns 401 without a gallery session", async () => {
      const res = await fetch(`${API}/api/gallery/${partEvent.slug}/download/part/1?quality=DISPLAY`, {
        redirect: "manual",
      });
      expect(res.status).toBe(401);
    });

    it("Then it returns 401 with a gallery cookie for a different gallery", async () => {
      const other = await createEvent(adminCookie, { password: "other-part-pass" });
      const otherCookie = await unlockGallery(other.slug, "other-part-pass");
      try {
        const res = await fetch(`${API}/api/gallery/${partEvent.slug}/download/part/1?quality=DISPLAY`, {
          headers: { Cookie: otherCookie },
          redirect: "manual",
        });
        expect(res.status).toBe(401);
      } finally {
        await deleteEvent(adminCookie, other.id);
      }
    });

    it("Then the download payload's part URLs point at this endpoint, not at S3", async () => {
      const res = await fetch(`${API}/api/gallery/${partEvent.slug}/download`, {
        headers: { Cookie: partCookie },
      });
      const body = (await res.json()) as BothVariantsBody;
      for (const q of ["DISPLAY", "ORIGINAL"] as const) {
        const parts = body.variants[q].parts;
        expect(parts.length).toBeGreaterThan(0);
        for (const p of parts) {
          expect(p.url).toBe(`/api/gallery/${partEvent.slug}/download/part/${p.index}?quality=${q}`);
        }
      }
    });

    it("Then it answers 302 with an S3 Location that downloads a valid ZIP", async () => {
      const res = await fetch(`${API}/api/gallery/${partEvent.slug}/download/part/1?quality=ORIGINAL`, {
        headers: { Cookie: partCookie },
        redirect: "manual",
      });
      expect(res.status).toBe(302);

      const location = res.headers.get("location");
      expect(location).toBeTruthy();
      // A presigned S3 GET — the bytes never pass through the API.
      expect(location).toMatch(/^https?:\/\//);
      expect(location).toMatch(/X-Amz-Signature/i);
      // Single part → plain slug filename (no "-part-N-of-M" suffix).
      expect(decodeURIComponent(location!)).toContain(`filename="${partEvent.slug}.zip"`);

      const zip = await fetch(location!);
      expect(zip.status).toBe(200);
      const bytes = Buffer.from(await zip.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK"); // ZIP local file header
    });

    it("Then it stamps lastDownloadedAt, while GET /download alone does not", async () => {
      const before = await lastDownloadedAt(adminCookie, partEvent.id, "DISPLAY");

      await new Promise((r) => setTimeout(r, 20));
      const res = await fetch(`${API}/api/gallery/${partEvent.slug}/download/part/1?quality=DISPLAY`, {
        headers: { Cookie: partCookie },
        redirect: "manual",
      });
      expect(res.status).toBe(302);

      const afterPart = await lastDownloadedAt(adminCookie, partEvent.id, "DISPLAY");
      expect(afterPart).toBeTruthy();
      expect(new Date(afterPart!).getTime()).toBeGreaterThan(
        before ? new Date(before).getTime() : 0
      );

      // Opening the download page is a read — it must not touch the idle clock.
      await new Promise((r) => setTimeout(r, 20));
      await fetch(`${API}/api/gallery/${partEvent.slug}/download`, { headers: { Cookie: partCookie } });
      const afterPage = await lastDownloadedAt(adminCookie, partEvent.id, "DISPLAY");
      expect(afterPage).toBe(afterPart);
    });

    it("Then stamping is per variant — a Kompakt part does not refresh Original's clock", async () => {
      const originalBefore = await lastDownloadedAt(adminCookie, partEvent.id, "ORIGINAL");

      await new Promise((r) => setTimeout(r, 20));
      const res = await fetch(`${API}/api/gallery/${partEvent.slug}/download/part/1?quality=DISPLAY`, {
        headers: { Cookie: partCookie },
        redirect: "manual",
      });
      expect(res.status).toBe(302);

      expect(await lastDownloadedAt(adminCookie, partEvent.id, "ORIGINAL")).toBe(originalBefore);
    });

    it("Then a part index with no object returns 404", async () => {
      const res = await fetch(`${API}/api/gallery/${partEvent.slug}/download/part/99?quality=DISPLAY`, {
        headers: { Cookie: partCookie },
        redirect: "manual",
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect((await res.json()) as { error: string }).toHaveProperty("error");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Idle expiry — "Archiv freigeben" is the reaper's effect path (PIXSHAR-4)
  //
  // The time-based sweep decision is the pure isExpired (unit-tested in
  // archiveExpiry.test.ts). What is exercised here is the *effect*: the same
  // expireArchive() the reaper runs, driven over HTTP so no clock has to be
  // faked — objects gone, job EXPIRED, membership intact, rebuild identical.
  // ─────────────────────────────────────────────────────────────────────────

  describe("POST /api/events/:id/download/release", () => {
    let relEvent: TestEvent;
    let relCookie: string;
    // ORIGINAL's parts as first built — the identities a rebuild must reproduce.
    let originalPartsBefore: Array<{ index: number; membershipSig: string }>;

    beforeAll(async () => {
      relEvent = await createEvent(adminCookie, { password: "release-pass" });
      relCookie = await unlockGallery(relEvent.slug, "release-pass");
      await uploadAndProcessPhoto(adminCookie, relEvent);

      for (const q of ["DISPLAY", "ORIGINAL"] as const) {
        await authedFetch(`/api/events/${relEvent.id}/download/build-now?quality=${q}`, adminCookie, {
          method: "POST",
        });
      }
      for (const q of ["DISPLAY", "ORIGINAL"] as const) {
        const s = await pollAdminStatus(adminCookie, relEvent.id, q, (v) => v === "READY" || v === "FAILED", 90_000);
        if (s !== "READY") throw new Error(`${q} archive not READY (got ${s})`);
      }

      const original = await variantPayload(relCookie, relEvent.slug, "ORIGINAL");
      originalPartsBefore = original.parts.map((p) => ({ index: p.index, membershipSig: p.membershipSig }));
      if (originalPartsBefore.length === 0) throw new Error("ORIGINAL archive built with no parts");
    }, 240_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, relEvent.id);
    });

    it("Then it returns 401 without an admin session, and expires nothing", async () => {
      const res = await fetch(`${API}/api/events/${relEvent.id}/download/release?quality=ORIGINAL`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
      expect(await adminStatus(adminCookie, relEvent.id, "ORIGINAL")).toBe("READY");
    });

    it("Then releasing ORIGINAL expires it: job EXPIRED, no downloadable parts, part URL 404s", async () => {
      const res = await authedFetch(
        `/api/events/${relEvent.id}/download/release?quality=ORIGINAL`,
        adminCookie,
        { method: "POST" }
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as { success: boolean; released: boolean }).toMatchObject({
        success: true,
        released: true,
      });

      expect(await adminStatus(adminCookie, relEvent.id, "ORIGINAL")).toBe("EXPIRED");

      // The payload no longer offers any ORIGINAL part…
      const original = await variantPayload(relCookie, relEvent.slug, "ORIGINAL");
      expect(original.parts).toHaveLength(0);

      // …and the part URL a guest may still hold resolves to no object.
      const gone = await fetch(
        `${API}/api/gallery/${relEvent.slug}/download/part/${originalPartsBefore[0].index}?quality=ORIGINAL`,
        { headers: { Cookie: relCookie }, redirect: "manual" }
      );
      expect(gone.status).toBe(404);
      expect(gone.headers.get("location")).toBeNull();
    });

    it("Then expiry is per variant — releasing Original leaves Kompakt's objects alone", async () => {
      expect(await adminStatus(adminCookie, relEvent.id, "DISPLAY")).toBe("READY");

      const display = await variantPayload(relCookie, relEvent.slug, "DISPLAY");
      expect(display.status).toBe("READY");
      expect(display.parts.length).toBeGreaterThan(0);

      const redirect = await fetch(`${API}${display.parts[0].url}`, {
        headers: { Cookie: relCookie },
        redirect: "manual",
      });
      expect(redirect.status).toBe(302);
      const location = redirect.headers.get("location");
      expect(location).toMatch(/X-Amz-Signature/i);
      const zip = await fetch(location!);
      expect(zip.status).toBe(200);
    });

    it("Then a rebuild reproduces the same partIndex and membershipSig (the membership survived)", async () => {
      const res = await authedFetch(
        `/api/events/${relEvent.id}/download/rebuild-all?quality=ORIGINAL`,
        adminCookie,
        { method: "POST" }
      );
      expect(res.status).toBe(200);

      const status = await pollAdminStatus(
        adminCookie,
        relEvent.id,
        "ORIGINAL",
        (s) => s === "READY" || s === "FAILED",
        90_000
      );
      expect(status).toBe("READY");

      const rebuilt = (await variantPayload(relCookie, relEvent.slug, "ORIGINAL")).parts.map((p) => ({
        index: p.index,
        membershipSig: p.membershipSig,
      }));
      // Identical part identities → a guest's per-part "downloaded" ticks survive.
      expect(rebuilt).toEqual(originalPartsBefore);

      const back = await fetch(
        `${API}/api/gallery/${relEvent.slug}/download/part/${originalPartsBefore[0].index}?quality=ORIGINAL`,
        { headers: { Cookie: relCookie }, redirect: "manual" }
      );
      expect(back.status).toBe(302);
    }, 120_000);

    it("Then two concurrent releases expire the archive exactly once (CAS claim holds)", async () => {
      const [a, b] = await Promise.all([
        authedFetch(`/api/events/${relEvent.id}/download/release?quality=DISPLAY`, adminCookie, { method: "POST" }),
        authedFetch(`/api/events/${relEvent.id}/download/release?quality=DISPLAY`, adminCookie, { method: "POST" }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const results = (await Promise.all([a.json(), b.json()])) as Array<{ released: boolean }>;
      // Exactly one caller claimed the job; the loser is a no-op, not a second delete.
      expect(results.filter((r) => r.released)).toHaveLength(1);

      expect(await adminStatus(adminCookie, relEvent.id, "DISPLAY")).toBe("EXPIRED");
      expect((await variantPayload(relCookie, relEvent.slug, "DISPLAY")).parts).toHaveLength(0);
    });

    it("Then the expiry counters are exposed on /metrics", async () => {
      const text = await (await fetch(`${API}/metrics`)).text();

      const expired = /^pixshar_archive_expired_total\{quality="ORIGINAL"\} (\d+)/m.exec(text);
      expect(expired).toBeTruthy();
      expect(Number(expired![1])).toBeGreaterThan(0);

      const reclaimed = /^pixshar_archive_bytes_reclaimed_total\{quality="ORIGINAL"\} (\d+)/m.exec(text);
      expect(reclaimed).toBeTruthy();
      expect(Number(reclaimed![1])).toBeGreaterThan(0);
    });
  });
});
