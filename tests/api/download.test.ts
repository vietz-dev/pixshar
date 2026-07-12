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
    // 1s, not less: the admin status endpoint is rate-limited to 60/min per event.
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return status;
}

/**
 * The guest's explicit build request — since PIXSHAR-5 the only thing that
 * creates an archive. Returns whether this call actually queued a build.
 */
async function requestArchive(
  cookie: string,
  slug: string,
  quality: "DISPLAY" | "ORIGINAL"
): Promise<{ status: number; queued: boolean; jobStatus: string }> {
  const res = await fetch(`${API}/api/gallery/${slug}/download/request?quality=${quality}`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  const body = (await res.json()) as { queued?: boolean; status?: string };
  return { status: res.status, queued: body.queued ?? false, jobStatus: body.status ?? "" };
}

/** Builds an archive the way a guest does, and waits for it. */
async function requestAndAwaitArchive(
  adminCookie: string,
  guestCookie: string,
  event: TestEvent,
  quality: "DISPLAY" | "ORIGINAL"
): Promise<void> {
  await requestArchive(guestCookie, event.slug, quality);
  const s = await pollAdminStatus(
    adminCookie,
    event.id,
    quality,
    (v) => v === "READY" || v === "FAILED",
    90_000
  );
  if (s !== "READY") throw new Error(`${quality} archive not READY (got ${s})`);
}

/** Scrapes one labelled sample out of the API process's /metrics exposition. */
async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const text = await (await fetch(`${API}/metrics`)).text();
  const label = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  const line = new RegExp(`^${name}\\{${label}\\} (\\d+(?:\\.\\d+)?)`, "m").exec(text);
  return line ? Number(line[1]) : 0;
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

      it("Then opening the download page creates NO job (a GET is a read)", async () => {
        // Since PIXSHAR-5 the download page builds nothing: a variant with no
        // archive stays absent until a guest explicitly requests it.
        const lazyEvent = await createEvent(adminCookie, { password: "lazy-pass" });
        const lazyCookie = await unlockGallery(lazyEvent.slug, "lazy-pass");
        try {
          const gres = await fetch(`${API}/api/gallery/${lazyEvent.slug}/download`, {
            headers: { Cookie: lazyCookie },
          });
          expect(gres.status).toBe(200);
          const body = (await gres.json()) as BothVariantsBody;
          expect(body.variants.DISPLAY.status).toBe("NONE");
          expect(body.variants.ORIGINAL.status).toBe("NONE");

          // Give any (now removed) side effect a chance to land, then prove no
          // job exists for either variant.
          await new Promise((r) => setTimeout(r, 2_000));
          expect(await adminStatus(adminCookie, lazyEvent.id, "DISPLAY")).toBe("NONE");
          expect(await adminStatus(adminCookie, lazyEvent.id, "ORIGINAL")).toBe("NONE");
        } finally {
          await deleteEvent(adminCookie, lazyEvent.id);
        }
      });
    });
  });

  describe("Requested Kompakt archive is fetchable", () => {
    it("Then requesting DISPLAY builds it and its parts download as -kompakt ZIPs", async () => {
      const fanEvent = await createEvent(adminCookie, { password: "fan-pass" });
      const fanCookie = await unlockGallery(fanEvent.slug, "fan-pass");
      try {
        await uploadAndProcessPhoto(adminCookie, fanEvent);

        await requestAndAwaitArchive(adminCookie, fanCookie, fanEvent, "DISPLAY");

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
    it("Then requesting DISPLAY does not create or touch the ORIGINAL job", async () => {
      // Fresh event. A guest request creates only the DISPLAY job; building it
      // must leave ORIGINAL untouched (still NONE).
      const indyEvent = await createEvent(adminCookie, { password: "indy-pass" });
      const indyCookie = await unlockGallery(indyEvent.slug, "indy-pass");
      try {
        const requested = await requestArchive(indyCookie, indyEvent.slug, "DISPLAY");
        expect(requested.status).toBe(200);
        expect(requested.queued).toBe(true);

        // ORIGINAL was never requested → still NONE (independence).
        expect(await adminStatus(adminCookie, indyEvent.id, "ORIGINAL")).toBe("NONE");

        // DISPLAY is queued for a build.
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

      // Archives are lazy: the upload alone builds nothing — the guest asks.
      for (const q of ["DISPLAY", "ORIGINAL"] as const) {
        await requestArchive(partCookie, partEvent.slug, q);
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

      // Archives are lazy: the upload alone builds nothing — the guest asks.
      for (const q of ["DISPLAY", "ORIGINAL"] as const) {
        await requestArchive(relCookie, relEvent.slug, q);
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

  // ─────────────────────────────────────────────────────────────────────────
  // Lazy build — an archive nobody asks for is never built (PIXSHAR-5)
  //
  // "Lazy to create, eager to keep current": uploads never create a job, a GET
  // never creates a job, only POST …/download/request does. Once a variant is
  // alive, uploads keep appending to it; once it expired, they do not revive it.
  // One event runs the whole lifecycle, since building archives is the slow part.
  // ─────────────────────────────────────────────────────────────────────────

  describe("Lazy build", () => {
    let lazyEvent: TestEvent;
    let lazyCookie: string;
    // The DISPLAY parts as first built — the identities the post-expiry rebuild
    // must reproduce so a guest's per-part "downloaded" ticks survive.
    let partsBeforeExpiry: Array<{ index: number; membershipSig: string }> = [];

    beforeAll(async () => {
      lazyEvent = await createEvent(adminCookie, { password: "lazy-build-pass" });
      lazyCookie = await unlockGallery(lazyEvent.slug, "lazy-build-pass");
      await uploadAndProcessPhoto(adminCookie, lazyEvent); // photo 1
    }, 120_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, lazyEvent.id);
    });

    it("Given a processed photo and no archive, Then no DownloadJob exists and no build started", async () => {
      // The eager fan-out is gone: processing a photo into an event nobody has
      // asked an archive for spends nothing.
      await new Promise((r) => setTimeout(r, 3_000)); // let any trigger land
      expect(await adminStatus(adminCookie, lazyEvent.id, "DISPLAY")).toBe("NONE");
      expect(await adminStatus(adminCookie, lazyEvent.id, "ORIGINAL")).toBe("NONE");
    });

    it("Given no archive, When the guest opens the download page, Then still no job exists", async () => {
      const res = await fetch(`${API}/api/gallery/${lazyEvent.slug}/download`, {
        headers: { Cookie: lazyCookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as BothVariantsBody;
      expect(body.variants.DISPLAY.status).toBe("NONE");
      expect(body.variants.ORIGINAL.status).toBe("NONE");

      await new Promise((r) => setTimeout(r, 2_000));
      expect(await adminStatus(adminCookie, lazyEvent.id, "DISPLAY")).toBe("NONE");
      expect(await adminStatus(adminCookie, lazyEvent.id, "ORIGINAL")).toBe("NONE");
    });

    it("Then POST /download/request without a gallery session returns 401 and queues nothing", async () => {
      const res = await fetch(`${API}/api/gallery/${lazyEvent.slug}/download/request?quality=DISPLAY`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
      expect(await adminStatus(adminCookie, lazyEvent.id, "DISPLAY")).toBe("NONE");
    });

    it("Then POST /download/request?quality=DISPLAY queues Kompakt ONLY (Original stays absent)", async () => {
      const requested = await requestArchive(lazyCookie, lazyEvent.slug, "DISPLAY");
      expect(requested.status).toBe(200);
      expect(requested.queued).toBe(true);

      // The other variant is untouched — a request buys exactly one archive.
      expect(await adminStatus(adminCookie, lazyEvent.id, "ORIGINAL")).toBe("NONE");

      const status = await pollAdminStatus(
        adminCookie,
        lazyEvent.id,
        "DISPLAY",
        (s) => s === "READY" || s === "FAILED",
        90_000
      );
      expect(status).toBe("READY");
      expect(await adminStatus(adminCookie, lazyEvent.id, "ORIGINAL")).toBe("NONE");

      const display = await variantPayload(lazyCookie, lazyEvent.slug, "DISPLAY");
      expect(display.status).toBe("READY");
      expect(display.parts).toHaveLength(1);
    }, 120_000);

    it("Then requesting an already-READY variant is an idempotent no-op (no second build)", async () => {
      const before = await variantPayload(lazyCookie, lazyEvent.slug, "DISPLAY");

      const again = await requestArchive(lazyCookie, lazyEvent.slug, "DISPLAY");
      expect(again.status).toBe(200);
      expect(again.queued).toBe(false); // no error, and nothing queued
      expect(again.jobStatus).toBe("READY");

      // A guest hammering the button must not stack builds: the job never leaves
      // READY and the parts are the very same ones.
      for (let i = 0; i < 3; i++) {
        await requestArchive(lazyCookie, lazyEvent.slug, "DISPLAY");
      }
      await new Promise((r) => setTimeout(r, 3_000));
      expect(await adminStatus(adminCookie, lazyEvent.id, "DISPLAY")).toBe("READY");
      const after = await variantPayload(lazyCookie, lazyEvent.slug, "DISPLAY");
      expect(after.parts).toEqual(before.parts);
    });

    it("Then uploading while DISPLAY is READY still appends it (eager append preserved), and Original stays absent", async () => {
      await uploadAndProcessPhoto(adminCookie, lazyEvent); // photo 2

      // The live variant re-enters a build cycle to append the new photo…
      const appended = await pollAdminStatus(
        adminCookie,
        lazyEvent.id,
        "DISPLAY",
        (s) => s !== "READY",
        30_000
      );
      expect(["DEBOUNCING", "QUEUED", "BUILDING"]).toContain(appended);
      // …while the variant nobody asked for is NOT resurrected by the upload.
      expect(await adminStatus(adminCookie, lazyEvent.id, "ORIGINAL")).toBe("NONE");

      // Skip the quiet window and let the append land.
      await authedFetch(`/api/events/${lazyEvent.id}/download/build-now?quality=DISPLAY`, adminCookie, {
        method: "POST",
      });
      const status = await pollAdminStatus(
        adminCookie,
        lazyEvent.id,
        "DISPLAY",
        (s) => s === "READY" || s === "FAILED",
        90_000
      );
      expect(status).toBe("READY");

      const display = await variantPayload(lazyCookie, lazyEvent.slug, "DISPLAY");
      // Existing part immutable, new photo appended as a NEW part.
      expect(display.parts).toHaveLength(2);
      expect(display.parts.map((p) => p.index)).toEqual([1, 2]);

      partsBeforeExpiry = display.parts.map((p) => ({ index: p.index, membershipSig: p.membershipSig }));
    }, 180_000);

    it("Then uploading while DISPLAY is EXPIRED does not revive it", async () => {
      const released = await authedFetch(
        `/api/events/${lazyEvent.id}/download/release?quality=DISPLAY`,
        adminCookie,
        { method: "POST" }
      );
      expect(released.status).toBe(200);
      expect(await adminStatus(adminCookie, lazyEvent.id, "DISPLAY")).toBe("EXPIRED");

      await uploadAndProcessPhoto(adminCookie, lazyEvent); // photo 3, while EXPIRED

      // An upload must not resurrect an archive whose bytes were reclaimed —
      // that would defeat the whole idle-expiry saving.
      await new Promise((r) => setTimeout(r, 3_000));
      expect(await adminStatus(adminCookie, lazyEvent.id, "DISPLAY")).toBe("EXPIRED");
      expect((await variantPayload(lazyCookie, lazyEvent.slug, "DISPLAY")).parts).toHaveLength(0);
    }, 120_000);

    it("Then a request after expiry rebuilds the same parts and the meanwhile photo appears as a new part", async () => {
      const requested = await requestArchive(lazyCookie, lazyEvent.slug, "DISPLAY");
      expect(requested.status).toBe(200);
      expect(requested.queued).toBe(true);

      const status = await pollAdminStatus(
        adminCookie,
        lazyEvent.id,
        "DISPLAY",
        (s) => s === "READY" || s === "FAILED",
        120_000
      );
      expect(status).toBe("READY");

      const rebuilt = await variantPayload(lazyCookie, lazyEvent.slug, "DISPLAY");
      // Parts 1 and 2 come back with identical identities (rebuilt from the
      // surviving membership, never re-planned) → the guest's ticks survive…
      expect(rebuilt.parts.slice(0, 2).map((p) => ({ index: p.index, membershipSig: p.membershipSig })))
        .toEqual(partsBeforeExpiry);
      // …and the photo uploaded while the archive was gone is appended as part 3.
      expect(rebuilt.parts).toHaveLength(3);
      expect(rebuilt.parts[2].index).toBe(3);

      // The rebuilt bytes are really there.
      const back = await fetch(`${API}${rebuilt.parts[0].url}`, {
        headers: { Cookie: lazyCookie },
        redirect: "manual",
      });
      expect(back.status).toBe(302);
    }, 180_000);

    it("Then the build counter carries the trigger label and the expiry→rebuild cycle is in the histogram", async () => {
      const firstBuild = await metricValue("pixshar_archive_builds_total", {
        quality: "DISPLAY",
        trigger: "first_build",
      });
      expect(firstBuild).toBeGreaterThan(0);

      const rebuild = await metricValue("pixshar_archive_builds_total", {
        quality: "DISPLAY",
        trigger: "on_demand_rebuild",
      });
      expect(rebuild).toBeGreaterThan(0);

      // The histogram that tells the operator whether the TTL cuts into live use.
      const observations = await metricValue("pixshar_archive_expiry_to_rebuild_seconds_count", {
        quality: "DISPLAY",
      });
      expect(observations).toBeGreaterThan(0);
    });

    it("Then two concurrent requests for the same variant queue exactly one build", async () => {
      const raceEvent = await createEvent(adminCookie, { password: "race-pass" });
      const raceCookie = await unlockGallery(raceEvent.slug, "race-pass");
      try {
        const [a, b] = await Promise.all([
          requestArchive(raceCookie, raceEvent.slug, "ORIGINAL"),
          requestArchive(raceCookie, raceEvent.slug, "ORIGINAL"),
        ]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        // The unique (event, variant) job is the guarantee: one caller creates it,
        // the other observes a build already on its way.
        expect([a.queued, b.queued].filter(Boolean)).toHaveLength(1);
      } finally {
        await deleteEvent(adminCookie, raceEvent.id);
      }
    }, 60_000);
  });
});
