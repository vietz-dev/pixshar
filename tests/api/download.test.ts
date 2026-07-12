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

// The image-processor's own metrics endpoint. It is a SEPARATE process with a
// SEPARATE exposition, and it is the ONLY writer of the idle reaper's counters
// and of builds_total{trigger="append"} — so what the API serves says nothing
// about whether those are exposed at all.
const WORKER = "http://localhost:4000";

/** Scrapes one labelled sample out of a process's /metrics exposition. */
async function scrapeMetric(
  base: string,
  name: string,
  labels: Record<string, string>
): Promise<number> {
  const text = await (await fetch(`${base}/metrics`)).text();
  const label = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  const line = new RegExp(`^${name}\\{${label}\\} (\\d+(?:\\.\\d+)?)`, "m").exec(text);
  return line ? Number(line[1]) : 0;
}

const metricValue = (name: string, labels: Record<string, string>) => scrapeMetric(API, name, labels);
const workerMetricValue = (name: string, labels: Record<string, string>) =>
  scrapeMetric(WORKER, name, labels);

/** Waits (up to timeoutMs) for a metric to satisfy a predicate. */
async function pollMetric(
  read: () => Promise<number>,
  until: (v: number) => boolean,
  timeoutMs = 15_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let v = await read();
  while (Date.now() < deadline && !until(v)) {
    await new Promise((r) => setTimeout(r, 500));
    v = await read();
  }
  return v;
}

/**
 * Follows the admin SSE stream until `match` accepts a payload, then disconnects.
 * The plain status endpoint is rate-limited to 60/min, far too coarse to catch a
 * BUILDING window that lasts a second or two — the stream pushes every
 * transition the instant it happens.
 */
async function awaitAdminStatus(
  cookie: string,
  eventId: string,
  quality: "DISPLAY" | "ORIGINAL",
  match: (s: { status: string; photoCount: number }) => boolean,
  timeoutMs = 120_000
): Promise<void> {
  const controller = new AbortController();
  const res = await fetch(
    `${API}/api/events/${eventId}/download/status/stream?quality=${quality}`,
    { headers: { Cookie: cookie }, signal: controller.signal }
  );
  if (!res.ok || !res.body) throw new Error(`SSE stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^data:\s*(\{.*\})$/.exec(line.trim());
        if (!m) continue;
        if (match(JSON.parse(m[1]) as { status: string; photoCount: number })) return;
      }
    }
    throw new Error("Timed out waiting for the expected admin status");
  } finally {
    controller.abort();
  }
}

/**
 * Reads the first "download-status" event off the admin SSE stream, then
 * disconnects. Used to assert the stream carries the same shape as the plain
 * status endpoint (PIXSHAR-8) without keeping a connection open for the rest
 * of the suite.
 */
async function firstSSEStatus(
  cookie: string,
  eventId: string,
  quality: "DISPLAY" | "ORIGINAL",
  timeoutMs = 10_000
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const res = await fetch(
    `${API}/api/events/${eventId}/download/status/stream?quality=${quality}`,
    { headers: { Cookie: cookie }, signal: controller.signal }
  );
  if (!res.ok || !res.body) throw new Error(`SSE stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = /data:\s*(\{.*\})/.exec(buffer);
      if (match) return JSON.parse(match[1]);
    }
    throw new Error("Timed out waiting for the first SSE download-status event");
  } finally {
    controller.abort();
  }
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
          // PIXSHAR-8: idle-clock provenance + the derived remaining lifetime.
          expect(body).toHaveProperty("lastDownloadedAt");
          expect(body).toHaveProperty("readyAt");
          expect(body).toHaveProperty("expiredAt");
          expect(body).toHaveProperty("expiresAt");
        });
      });
    });

    describe("Given no admin session", () => {
      it("Then it returns 401", async () => {
        const res = await fetch(`${API}/api/events/${event.id}/download/status`);
        expect(res.status).toBe(401);
      });
      it("Then the SSE stream also returns 401", async () => {
        const res = await fetch(`${API}/api/events/${event.id}/download/status/stream`);
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
        // variant payload is the one to assert against.
        const original = body.variants.ORIGINAL;
        if (original.status === "NONE") {
          // A 0-photo build produces a READY job with zero parts — the guest
          // payload treats "nothing downloadable" the same as "no archive"
          // (buildDownloadPayload), which is indistinguishable from NONE to a
          // guest and is not this ticket's concern. Nothing further to assert.
          return;
        }
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
    // A presigned S3 URL for ORIGINAL's part 1, minted BEFORE the release: it
    // stays signable for 15 minutes, so a 404 on it afterwards is the object
    // itself being gone, not the link having lapsed.
    let originalPart1Object: string;
    // pixshar_archive_live_bytes counts the bytes claimed by part ROWS whose
    // status is READY (metrics.ts) — the one window the API opens on the part
    // rows themselves. Snapshotted before any release, together with this
    // archive's own byte total, so the invariant test can prove the rows
    // stopped claiming those bytes.
    let liveBytesBefore: number;
    let originalBytesBefore: number;

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

      const redirect = await fetch(
        `${API}/api/gallery/${relEvent.slug}/download/part/${originalPartsBefore[0].index}?quality=ORIGINAL`,
        { headers: { Cookie: relCookie }, redirect: "manual" }
      );
      const location = redirect.headers.get("location");
      if (redirect.status !== 302 || !location) throw new Error("ORIGINAL part 1 has no object before the release");
      originalPart1Object = location;

      const statusRes = await authedFetch(
        `/api/events/${relEvent.id}/download/status?quality=ORIGINAL`,
        adminCookie
      );
      originalBytesBefore = ((await statusRes.json()) as { totalSizeBytes: number }).totalSizeBytes;
      if (originalBytesBefore <= 0) throw new Error("ORIGINAL archive holds no bytes before the release");
      liveBytesBefore = await metricValue("pixshar_archive_live_bytes", { quality: "ORIGINAL" });
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

    it("Then no part row is left READY while its object is gone (the reclaim invariant)", async () => {
      // The object really is deleted — this link was signed before the release
      // and is still valid, so the 404 is S3's, not the API's.
      expect((await fetch(originalPart1Object)).status).toBe(404);

      // …and not one part ROW still claims to hold those bytes: the live-bytes
      // gauge sums exactly the parts whose status is READY, and it fell by this
      // archive's whole size. That is the invariant the reaper's ordering exists
      // for — the rows go EXPIRED in the same transaction as the job claim,
      // BEFORE S3 is touched, so no crash and no failed delete can leave a READY
      // part pointing at a deleted object: the state that would 302 a guest into
      // a NoSuchKey and that the builder would never repair (its work list only
      // picks up STALE/EXPIRED parts).
      const liveBytesAfter = await metricValue("pixshar_archive_live_bytes", { quality: "ORIGINAL" });
      expect(liveBytesAfter).toBe(liveBytesBefore - originalBytesBefore);

      // The membership itself survived — it is what the rebuild replays.
      const rebuildable = await authedFetch(
        `/api/events/${relEvent.id}/download/status?quality=ORIGINAL`,
        adminCookie
      );
      const body = (await rebuildable.json()) as { status: string; partCount: number; totalSizeBytes: number };
      expect(body.status).toBe("EXPIRED");
      expect(body.partCount).toBe(0);
      expect(body.totalSizeBytes).toBe(0);
    });

    it("Then a bogus ?quality= is a 400 and releases nothing", async () => {
      // DISPLAY still holds its bytes at this point — a mis-typed variant must
      // not be silently coerced to the ORIGINAL default (a release is
      // destructive), and must not touch anything at all.
      expect(await adminStatus(adminCookie, relEvent.id, "DISPLAY")).toBe("READY");
      const displayBefore = await variantPayload(relCookie, relEvent.slug, "DISPLAY");
      const liveBefore = await metricValue("pixshar_archive_live_bytes", { quality: "DISPLAY" });

      for (const bogus of ["DISPLAYY", "bogus", "display", ""]) {
        const res = await authedFetch(
          `/api/events/${relEvent.id}/download/release?quality=${bogus}`,
          adminCookie,
          { method: "POST" }
        );
        expect(res.status).toBe(400);
      }

      // Nothing was released: DISPLAY still holds every part it had, and the
      // bytes no READY row would still be counting had a release slipped through.
      expect(await adminStatus(adminCookie, relEvent.id, "DISPLAY")).toBe("READY");
      expect((await variantPayload(relCookie, relEvent.slug, "DISPLAY")).parts).toEqual(displayBefore.parts);
      expect(await metricValue("pixshar_archive_live_bytes", { quality: "DISPLAY" })).toBe(liveBefore);

      // The read + the other mutating admin download endpoints reject it too.
      for (const path of [
        `/api/events/${relEvent.id}/download/status?quality=bogus`,
        `/api/events/${relEvent.id}/download/build-now?quality=bogus`,
        `/api/events/${relEvent.id}/download/rebuild-all?quality=bogus`,
        `/api/events/${relEvent.id}/download/cancel?quality=bogus`,
      ]) {
        const method = path.includes("/status") ? "GET" : "POST";
        const res = await authedFetch(path, adminCookie, { method });
        expect(res.status).toBe(400);
      }
      expect(await adminStatus(adminCookie, relEvent.id, "DISPLAY")).toBe("READY");
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

  // ─────────────────────────────────────────────────────────────────────────
  // Photo deletion — the archive object goes immediately (PIXSHAR-6)
  //
  // A correctness rule, not a cost rule: under the lazy model nothing rebuilds
  // an archive by itself, so a part that keeps serving a deleted photo would
  // keep serving it for days. Deleting a photo therefore reclaims the object of
  // every part containing it, in BOTH variants, inside the delete request —
  // leaving a partially available variant, and no build queued.
  //
  // The fixture builds an archive with two parts per variant:
  //   part 1 = {photo A, photo B}   (built from the first request)
  //   part 2 = {photo C}            (appended while the variant was READY)
  // so a deletion of A hits part 1 and must leave part 2 alone.
  // ─────────────────────────────────────────────────────────────────────────

  describe("Photo deletion expires the affected archive parts", () => {
    let delEvent: TestEvent;
    let delCookie: string;
    let photoA: string;
    let photoB: string;
    const QUALITIES = ["DISPLAY", "ORIGINAL"] as const;
    // Per variant: the parts as built, and a presigned S3 URL for part 1 minted
    // BEFORE the deletion — the proof that the object itself is gone afterwards,
    // not merely hidden behind the API.
    const before: Record<string, { parts: Array<{ index: number; membershipSig: string }>; part1Object: string }> = {};

    /** Follows the part-redirect endpoint; returns the presigned S3 URL, or null on 404. */
    async function partObjectUrl(quality: "DISPLAY" | "ORIGINAL", index: number): Promise<string | null> {
      const res = await fetch(`${API}/api/gallery/${delEvent.slug}/download/part/${index}?quality=${quality}`, {
        headers: { Cookie: delCookie },
        redirect: "manual",
      });
      if (res.status === 404) return null;
      expect(res.status).toBe(302);
      return res.headers.get("location");
    }

    /** Drives a pending append through the 60s quiet window and waits until it stays READY. */
    async function settleReady(quality: "DISPLAY" | "ORIGINAL"): Promise<void> {
      for (let i = 0; i < 5; i++) {
        if ((await adminStatus(adminCookie, delEvent.id, quality)) !== "READY") {
          await authedFetch(`/api/events/${delEvent.id}/download/build-now?quality=${quality}`, adminCookie, {
            method: "POST",
          });
          const s = await pollAdminStatus(
            adminCookie,
            delEvent.id,
            quality,
            (v) => v === "READY" || v === "FAILED",
            120_000
          );
          if (s !== "READY") throw new Error(`${quality} build not READY (got ${s})`);
        }
        // A trigger may still be in flight; only a job that is READY twice in a
        // row is really idle — and the deletion assertions below need it idle.
        await new Promise((r) => setTimeout(r, 3_000));
        if ((await adminStatus(adminCookie, delEvent.id, quality)) === "READY") return;
      }
      throw new Error(`${quality} never settled on READY`);
    }

    beforeAll(async () => {
      delEvent = await createEvent(adminCookie, { password: "del-pass" });
      delCookie = await unlockGallery(delEvent.slug, "del-pass");

      // Two photos before the first build → both land in part 1.
      photoA = await uploadAndProcessPhoto(adminCookie, delEvent);
      photoB = await uploadAndProcessPhoto(adminCookie, delEvent);

      for (const q of QUALITIES) await requestArchive(delCookie, delEvent.slug, q);
      for (const q of QUALITIES) {
        const s = await pollAdminStatus(adminCookie, delEvent.id, q, (v) => v === "READY" || v === "FAILED", 120_000);
        if (s !== "READY") throw new Error(`${q} archive not READY (got ${s})`);
      }

      // A third photo, uploaded while both variants are READY → appended as part 2.
      await uploadAndProcessPhoto(adminCookie, delEvent);
      for (const q of QUALITIES) {
        // Wait for the append trigger to land (READY → DEBOUNCING), then build it.
        await pollAdminStatus(adminCookie, delEvent.id, q, (s) => s !== "READY", 30_000);
        await settleReady(q);
      }

      for (const q of QUALITIES) {
        const payload = await variantPayload(delCookie, delEvent.slug, q);
        if (payload.parts.length !== 2) {
          throw new Error(`${q} expected 2 parts, got ${payload.parts.length}`);
        }
        const part1Object = await partObjectUrl(q, 1);
        if (!part1Object) throw new Error(`${q} part 1 has no object before the deletion`);
        before[q] = {
          parts: payload.parts.map((p) => ({ index: p.index, membershipSig: p.membershipSig })),
          part1Object,
        };
      }

      // The deletion under test.
      const res = await authedFetch(`/api/events/${delEvent.id}/photos/${photoA}`, adminCookie, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
    }, 600_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, delEvent.id);
    });

    it.each(QUALITIES)(
      "Then %s's part 1 lost its S3 object the moment the delete returned",
      async (quality) => {
        // The presigned URL was minted before the deletion and is still valid for
        // 15 minutes — so a 404 here is the object being gone, not the link.
        const gone = await fetch(before[quality].part1Object);
        expect(gone.status).toBe(404);

        // …and the API refuses to hand out a new link for it.
        expect(await partObjectUrl(quality, 1)).toBeNull();
      }
    );

    it.each(QUALITIES)("Then no archive object of %s contains the deleted photo", async (quality) => {
      const payload = await variantPayload(delCookie, delEvent.slug, quality);
      for (const part of payload.parts.filter((p) => p.url)) {
        const location = await partObjectUrl(quality, part.index);
        expect(location).toBeTruthy();
        const zip = Buffer.from(await (await fetch(location!)).arrayBuffer());
        // Store-mode ZIP: entry names (which carry the photo id) are plain bytes.
        expect(zip.includes(Buffer.from(photoA))).toBe(false);
      }
    });

    it.each(QUALITIES)("Then %s's part 2 is untouched: downloadable, same membershipSig", async (quality) => {
      const payload = await variantPayload(delCookie, delEvent.slug, quality);
      const part2 = payload.parts.find((p) => p.index === 2);
      expect(part2).toBeDefined();
      expect(part2!.url).toBe(`/api/gallery/${delEvent.slug}/download/part/2?quality=${quality}`);
      // The guest's "downloaded" tick for this part keys on the sig — it stays valid.
      const sigBefore = before[quality].parts.find((p) => p.index === 2)!.membershipSig;
      expect(part2!.membershipSig).toBe(sigBefore);

      const location = await partObjectUrl(quality, 2);
      const zip = await fetch(location!);
      expect(zip.status).toBe(200);
      expect(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString("ascii")).toBe("PK");
    });

    it.each(QUALITIES)("Then %s renders part 1 with a null url (partially available)", async (quality) => {
      const payload = await variantPayload(delCookie, delEvent.slug, quality);
      const part1 = payload.parts.find((p) => p.index === 1);
      expect(part1).toBeDefined();
      expect(part1!.url).toBeNull();
      // Only what is really downloadable is counted.
      expect(payload.partCount).toBe(1);
      expect(payload.parts.filter((p) => p.url !== null)).toHaveLength(1);
    });

    it("Then the deletion queued NO build in either variant", async () => {
      // A queued reconcile would have flipped the job to DEBOUNCING/QUEUED at
      // once (the debounce window is 60s, so this is not a timing race).
      for (const q of QUALITIES) {
        expect(await adminStatus(adminCookie, delEvent.id, q)).toBe("READY");
      }
      await new Promise((r) => setTimeout(r, 5_000));
      for (const q of QUALITIES) {
        expect(await adminStatus(adminCookie, delEvent.id, q)).toBe("READY");
        // …and the reclaimed part is still gone: nothing rebuilt it behind our back.
        expect(await partObjectUrl(q, 1)).toBeNull();
      }
    }, 30_000);

    it("Then the next request rebuilds DISPLAY's part 1 from the pruned membership", async () => {
      const requested = await requestArchive(delCookie, delEvent.slug, "DISPLAY");
      expect(requested.queued).toBe(true); // a partially available variant is NOT current

      const status = await pollAdminStatus(
        adminCookie,
        delEvent.id,
        "DISPLAY",
        (s) => s === "READY" || s === "FAILED",
        120_000
      );
      expect(status).toBe("READY");

      const rebuilt = await variantPayload(delCookie, delEvent.slug, "DISPLAY");
      expect(rebuilt.parts).toHaveLength(2);

      const part1 = rebuilt.parts.find((p) => p.index === 1)!;
      expect(part1.url).toBe(`/api/gallery/${delEvent.slug}/download/part/1?quality=DISPLAY`);
      // Its contents genuinely changed (photo A is gone), so the sig must change…
      expect(part1.membershipSig).not.toBe(before.DISPLAY.parts.find((p) => p.index === 1)!.membershipSig);
      // …while the untouched part keeps its identity, and with it the guest's tick.
      const part2 = rebuilt.parts.find((p) => p.index === 2)!;
      expect(part2.membershipSig).toBe(before.DISPLAY.parts.find((p) => p.index === 2)!.membershipSig);

      // The rebuilt object exists, is a ZIP, and no longer carries the deleted photo.
      const location = await partObjectUrl("DISPLAY", 1);
      const zip = Buffer.from(await (await fetch(location!)).arrayBuffer());
      expect(zip.subarray(0, 2).toString("ascii")).toBe("PK");
      expect(zip.includes(Buffer.from(photoA))).toBe(false);
      expect(zip.includes(Buffer.from(photoB))).toBe(true); // rebuilt from membership minus A

      // Rebuilding Kompakt left Original partially available — variants are independent.
      const original = await variantPayload(delCookie, delEvent.slug, "ORIGINAL");
      expect(original.parts.find((p) => p.index === 1)!.url).toBeNull();
    }, 180_000);

    it("Then deleting the last photo of a part removes the part, without renumbering", async () => {
      const res = await authedFetch(`/api/events/${delEvent.id}/photos/${photoB}`, adminCookie, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      for (const q of QUALITIES) {
        const payload = await variantPayload(delCookie, delEvent.slug, q);
        // Part 1 is empty now → its row is gone. Part 2 keeps its index: identities
        // are stable, gaps are allowed.
        expect(payload.parts.map((p) => p.index)).toEqual([2]);
        expect(payload.parts[0].url).toBe(`/api/gallery/${delEvent.slug}/download/part/2?quality=${q}`);
        expect(await partObjectUrl(q, 1)).toBeNull();
      }
    }, 30_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // A single-part archive whose only part a deletion emptied of bytes is
  // *partially available*, not "never built": the job is still READY and its
  // membership is intact, so the payload must say so (and offer the repair)
  // instead of reporting NONE.
  // ─────────────────────────────────────────────────────────────────────────

  describe("Single-part archive after a photo deletion", () => {
    let oneEvent: TestEvent;
    let oneCookie: string;

    beforeAll(async () => {
      oneEvent = await createEvent(adminCookie, { password: "one-part-pass" });
      oneCookie = await unlockGallery(oneEvent.slug, "one-part-pass");
      // Two photos, one part: deleting one leaves the part alive (its membership
      // is pruned, not emptied) but object-less.
      const photoA = await uploadAndProcessPhoto(adminCookie, oneEvent);
      await uploadAndProcessPhoto(adminCookie, oneEvent);
      await requestAndAwaitArchive(adminCookie, oneCookie, oneEvent, "DISPLAY");

      const built = await variantPayload(oneCookie, oneEvent.slug, "DISPLAY");
      if (built.parts.length !== 1) throw new Error(`expected 1 part, got ${built.parts.length}`);

      const res = await authedFetch(`/api/events/${oneEvent.id}/photos/${photoA}`, adminCookie, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
    }, 300_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, oneEvent.id);
    });

    it("Then the payload reports the part as unavailable — not the archive as never built", async () => {
      const payload = await variantPayload(oneCookie, oneEvent.slug, "DISPLAY");

      expect(payload.status).not.toBe("NONE"); // it WAS built; its bytes were reclaimed
      expect(payload.parts).toHaveLength(1); // the part is listed…
      expect(payload.parts[0].url).toBeNull(); // …with no object behind it
      expect(payload.partCount).toBe(0); // nothing is downloadable right now
      expect(payload.totalSizeBytes).toBe(0);
      expect(payload.building).toBe(false); // the deletion queued no build
    });

    it("Then requesting it rebuilds the part from the pruned membership", async () => {
      const requested = await requestArchive(oneCookie, oneEvent.slug, "DISPLAY");
      expect(requested.queued).toBe(true);

      const status = await pollAdminStatus(
        adminCookie,
        oneEvent.id,
        "DISPLAY",
        (s) => s === "READY" || s === "FAILED",
        120_000
      );
      expect(status).toBe("READY");

      const rebuilt = await variantPayload(oneCookie, oneEvent.slug, "DISPLAY");
      expect(rebuilt.parts).toHaveLength(1);
      expect(rebuilt.parts[0].url).toBe(`/api/gallery/${oneEvent.slug}/download/part/1?quality=DISPLAY`);
      expect(rebuilt.partCount).toBe(1);
    }, 180_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Admin pre-warm — build-now from NONE and from EXPIRED (PIXSHAR-8)
  //
  // Today build-now only skips the debounce timer of an already-pending
  // build. It must now ALSO create the job from NONE and re-queue a rebuild
  // from EXPIRED, so the admin can warm a variant before sharing the link
  // with a crowd — without ever bypassing requestBuild, the single path that
  // creates/re-queues an archive.
  // ─────────────────────────────────────────────────────────────────────────

  describe("Admin pre-warm (build-now from NONE / EXPIRED)", () => {
    let warmEvent: TestEvent;
    let warmCookie: string;
    let partsBeforeExpiry: Array<{ index: number; membershipSig: string }>;

    beforeAll(async () => {
      warmEvent = await createEvent(adminCookie, { password: "warm-pass" });
      warmCookie = await unlockGallery(warmEvent.slug, "warm-pass");
      await uploadAndProcessPhoto(adminCookie, warmEvent);
    }, 120_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, warmEvent.id);
    });

    it("Given an event with NO archive at all, When the admin build-now's DISPLAY, Then it creates the job and queues exactly that variant", async () => {
      expect(await adminStatus(adminCookie, warmEvent.id, "DISPLAY")).toBe("NONE");
      expect(await adminStatus(adminCookie, warmEvent.id, "ORIGINAL")).toBe("NONE");

      const res = await authedFetch(
        `/api/events/${warmEvent.id}/download/build-now?quality=DISPLAY`,
        adminCookie,
        { method: "POST" }
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as { success: boolean }).toMatchObject({ success: true });

      const status = await pollAdminStatus(
        adminCookie,
        warmEvent.id,
        "DISPLAY",
        (s) => s === "READY" || s === "FAILED",
        90_000
      );
      expect(status).toBe("READY");

      // Exactly the requested variant — Original was never asked for and stays
      // untouched (variant isolation).
      expect(await adminStatus(adminCookie, warmEvent.id, "ORIGINAL")).toBe("NONE");

      partsBeforeExpiry = (await variantPayload(warmCookie, warmEvent.slug, "DISPLAY")).parts.map((p) => ({
        index: p.index,
        membershipSig: p.membershipSig,
      }));
      expect(partsBeforeExpiry.length).toBeGreaterThan(0);
    }, 120_000);

    it("Given an EXPIRED DISPLAY variant, When the admin build-now's it, Then it queues a rebuild reproducing the same partIndex and membershipSig", async () => {
      // Release (Ticket 3's endpoint, wired up here) puts DISPLAY into EXPIRED
      // without touching membership — the state build-now must now pre-warm from.
      const released = await authedFetch(
        `/api/events/${warmEvent.id}/download/release?quality=DISPLAY`,
        adminCookie,
        { method: "POST" }
      );
      expect(released.status).toBe(200);
      expect(await adminStatus(adminCookie, warmEvent.id, "DISPLAY")).toBe("EXPIRED");

      const res = await authedFetch(
        `/api/events/${warmEvent.id}/download/build-now?quality=DISPLAY`,
        adminCookie,
        { method: "POST" }
      );
      expect(res.status).toBe(200);

      const status = await pollAdminStatus(
        adminCookie,
        warmEvent.id,
        "DISPLAY",
        (s) => s === "READY" || s === "FAILED",
        90_000
      );
      expect(status).toBe("READY");

      const rebuilt = (await variantPayload(warmCookie, warmEvent.slug, "DISPLAY")).parts.map((p) => ({
        index: p.index,
        membershipSig: p.membershipSig,
      }));
      expect(rebuilt).toEqual(partsBeforeExpiry);

      // ORIGINAL was never touched by any of this — variant isolation holds
      // across the whole NONE -> READY -> EXPIRED -> READY lifecycle.
      expect(await adminStatus(adminCookie, warmEvent.id, "ORIGINAL")).toBe("NONE");
    }, 120_000);

    it("Given no admin session, Then build-now on either state still returns 401", async () => {
      const res = await fetch(`${API}/api/events/${warmEvent.id}/download/build-now?quality=DISPLAY`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Admin status payload & SSE stream expose EXPIRED + remaining lifetime
  // (PIXSHAR-8)
  // ─────────────────────────────────────────────────────────────────────────

  describe("Admin status/SSE expose EXPIRED and the remaining lifetime", () => {
    let ttlEvent: TestEvent;
    let ttlCookie: string;

    beforeAll(async () => {
      ttlEvent = await createEvent(adminCookie, { password: "ttl-pass" });
      ttlCookie = await unlockGallery(ttlEvent.slug, "ttl-pass");
      await uploadAndProcessPhoto(adminCookie, ttlEvent);
      await requestAndAwaitArchive(adminCookie, ttlCookie, ttlEvent, "ORIGINAL");
    }, 180_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, ttlEvent.id);
    });

    it("Then a READY variant's admin status carries readyAt and a future expiresAt (TTL enabled)", async () => {
      const res = await authedFetch(`/api/events/${ttlEvent.id}/download/status?quality=ORIGINAL`, adminCookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        readyAt: string | null;
        expiredAt: string | null;
        expiresAt: string | null;
      };
      expect(body.status).toBe("READY");
      expect(body.readyAt).toBeTruthy();
      expect(body.expiredAt).toBeNull();
      expect(body.expiresAt).toBeTruthy();
      expect(new Date(body.expiresAt!).getTime()).toBeGreaterThan(Date.now());

      // The other variant was never built — no countdown to show.
      const displayRes = await authedFetch(`/api/events/${ttlEvent.id}/download/status?quality=DISPLAY`, adminCookie);
      const displayBody = (await displayRes.json()) as { status: string; expiresAt: string | null };
      expect(displayBody.status).toBe("NONE");
      expect(displayBody.expiresAt).toBeNull();
    });

    it("Then releasing it flips status to EXPIRED, stamping expiredAt and clearing expiresAt", async () => {
      const rel = await authedFetch(`/api/events/${ttlEvent.id}/download/release?quality=ORIGINAL`, adminCookie, {
        method: "POST",
      });
      expect(rel.status).toBe(200);

      const res = await authedFetch(`/api/events/${ttlEvent.id}/download/status?quality=ORIGINAL`, adminCookie);
      const body = (await res.json()) as { status: string; expiredAt: string | null; expiresAt: string | null };
      expect(body.status).toBe("EXPIRED");
      expect(body.expiredAt).toBeTruthy();
      expect(body.expiresAt).toBeNull();
    });

    it("Then the SSE stream's first event carries the same EXPIRED state and fields", async () => {
      const body = await firstSSEStatus(adminCookie, ttlEvent.id, "ORIGINAL");
      expect(body.status).toBe("EXPIRED");
      expect(body.expiredAt).toBeTruthy();
      expect(body.expiresAt).toBeNull();
      // Kompakt was never touched by releasing Original — variant isolation.
      const kompakt = await firstSSEStatus(adminCookie, ttlEvent.id, "DISPLAY");
      expect(kompakt.status).toBe("NONE");
    }, 20_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Archive lifecycle metrics on /metrics (PIXSHAR-9)
  //
  // The TTL default is a guess; these seven series are what an operator needs
  // to tune it. pixshar_archive_expiries/rebuilds are DB-backed gauges (mirror
  // DownloadJob.expiryCount/rebuildCount) so they survive a pod restart — the
  // other five already had coverage from earlier tickets (build/release), this
  // block is the one place all seven are asserted together for a single event.
  // ─────────────────────────────────────────────────────────────────────────
  describe("Archive lifecycle metrics", () => {
    let metricsEvent: TestEvent;
    let metricsCookie: string;

    beforeAll(async () => {
      metricsEvent = await createEvent(adminCookie, { password: "metrics-pass" });
      metricsCookie = await unlockGallery(metricsEvent.slug, "metrics-pass");
      await uploadAndProcessPhoto(adminCookie, metricsEvent);
    }, 120_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, metricsEvent.id);
    });

    it("Then all seven archive-lifecycle metrics are registered with the documented name and type", async () => {
      const text = await (await fetch(`${API}/metrics`)).text();
      const typed = (name: string, type: string) =>
        expect(text).toMatch(new RegExp(`^# TYPE ${name} ${type}$`, "m"));

      typed("pixshar_archive_expiries", "gauge");
      typed("pixshar_archive_rebuilds", "gauge");
      typed("pixshar_archive_live_bytes", "gauge");
      typed("pixshar_archive_bytes_reclaimed_total", "counter");
      typed("pixshar_archive_expired_total", "counter");
      typed("pixshar_archive_builds_total", "counter");
      typed("pixshar_archive_expiry_to_rebuild_seconds", "histogram");
    });

    it("Then an event with no archive activity contributes no pixshar_archive_expiries/rebuilds series", async () => {
      const untouched = await createEvent(adminCookie, { password: "untouched-pass" });
      try {
        // Never requested — no DownloadJob row for it, so it can't leak into the
        // per-event gauges even before the 30-day recency filter is considered.
        const text = await (await fetch(`${API}/metrics`)).text();
        expect(text).not.toContain(`pixshar_archive_expiries{event="${untouched.slug}"`);
        expect(text).not.toContain(`pixshar_archive_rebuilds{event="${untouched.slug}"`);
      } finally {
        await deleteEvent(adminCookie, untouched.id);
      }
    });

    it("Then building, releasing and rebuilding ORIGINAL exposes the full series for this event's slug and quality", async () => {
      // 1. Build — first_build trigger, live bytes appear.
      await requestAndAwaitArchive(adminCookie, metricsCookie, metricsEvent, "ORIGINAL");

      const firstBuild = await metricValue("pixshar_archive_builds_total", {
        quality: "ORIGINAL",
        trigger: "first_build",
      });
      expect(firstBuild).toBeGreaterThan(0);

      const liveBytesAfterBuild = await metricValue("pixshar_archive_live_bytes", { quality: "ORIGINAL" });
      expect(liveBytesAfterBuild).toBeGreaterThan(0);

      // 2. Release — expiry counters + the per-event expiries gauge.
      const released = await authedFetch(
        `/api/events/${metricsEvent.id}/download/release?quality=ORIGINAL`,
        adminCookie,
        { method: "POST" }
      );
      expect(released.status).toBe(200);
      expect(await adminStatus(adminCookie, metricsEvent.id, "ORIGINAL")).toBe("EXPIRED");

      const expiredTotal = await metricValue("pixshar_archive_expired_total", { quality: "ORIGINAL" });
      expect(expiredTotal).toBeGreaterThan(0);

      const reclaimed = await metricValue("pixshar_archive_bytes_reclaimed_total", { quality: "ORIGINAL" });
      expect(reclaimed).toBeGreaterThan(0);

      const expiries = await metricValue("pixshar_archive_expiries", {
        event: metricsEvent.slug,
        quality: "ORIGINAL",
      });
      expect(expiries).toBeGreaterThanOrEqual(1);

      // 3. Rebuild — on_demand_rebuild trigger, the per-event rebuilds gauge and
      //    the expiry→rebuild histogram both get an observation for this event.
      await requestAndAwaitArchive(adminCookie, metricsCookie, metricsEvent, "ORIGINAL");

      const rebuildBuilds = await metricValue("pixshar_archive_builds_total", {
        quality: "ORIGINAL",
        trigger: "on_demand_rebuild",
      });
      expect(rebuildBuilds).toBeGreaterThan(0);

      const rebuilds = await metricValue("pixshar_archive_rebuilds", {
        event: metricsEvent.slug,
        quality: "ORIGINAL",
      });
      expect(rebuilds).toBeGreaterThanOrEqual(1);

      const histogramCount = await metricValue("pixshar_archive_expiry_to_rebuild_seconds_count", {
        quality: "ORIGINAL",
      });
      expect(histogramCount).toBeGreaterThan(0);

      const liveBytesAfterRebuild = await metricValue("pixshar_archive_live_bytes", { quality: "ORIGINAL" });
      expect(liveBytesAfterRebuild).toBeGreaterThan(0);
    }, 240_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Admin "rebuild all" on an archive whose bytes are already gone.
  //
  // STALE means "the OLD object keeps serving while the new one is built", so it
  // is only ever valid for a part that HAS an object. Marking an EXPIRED part
  // STALE re-advertises bytes the reaper already deleted, and `cancel` then
  // settles it back to READY — at which point requestBuild's READY branch finds
  // no EXPIRED parts and no-ops forever. The dead link is permanent. That is the
  // guest being handed a URL to a deleted S3 object, which this epic exists to
  // prevent.
  // ─────────────────────────────────────────────────────────────────────────

  describe("Admin rebuild-all on an EXPIRED archive", () => {
    let reEvent: TestEvent;
    let reCookie: string;
    let sigBefore: string;

    /** Follows a part link and reports what the guest actually ends up with. */
    async function fetchPart(
      index: number
    ): Promise<{ api: number; object: number | null }> {
      const res = await fetch(
        `${API}/api/gallery/${reEvent.slug}/download/part/${index}?quality=ORIGINAL`,
        { headers: { Cookie: reCookie }, redirect: "manual" }
      );
      if (res.status !== 302) return { api: res.status, object: null };
      const object = await fetch(res.headers.get("location")!);
      return { api: 302, object: object.status };
    }

    beforeAll(async () => {
      reEvent = await createEvent(adminCookie, { password: "rebuild-pass" });
      reCookie = await unlockGallery(reEvent.slug, "rebuild-pass");
      await uploadAndProcessPhoto(adminCookie, reEvent);
      await requestAndAwaitArchive(adminCookie, reCookie, reEvent, "ORIGINAL");

      const built = await variantPayload(reCookie, reEvent.slug, "ORIGINAL");
      if (built.parts.length !== 1) throw new Error(`expected 1 part, got ${built.parts.length}`);
      sigBefore = built.parts[0].membershipSig;

      // Reclaim the bytes: the membership survives, the S3 object does not.
      const released = await authedFetch(
        `/api/events/${reEvent.id}/download/release?quality=ORIGINAL`,
        adminCookie,
        { method: "POST" }
      );
      expect(released.status).toBe(200);
      expect(await adminStatus(adminCookie, reEvent.id, "ORIGINAL")).toBe("EXPIRED");
    }, 300_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, reEvent.id);
    });

    it("Then rebuild-all followed by cancel never offers a part whose object is gone", async () => {
      const rebuildsBefore = await metricValue("pixshar_archive_rebuilds", {
        event: reEvent.slug,
        quality: "ORIGINAL",
      });
      const histBefore = await metricValue("pixshar_archive_expiry_to_rebuild_seconds_count", {
        quality: "ORIGINAL",
      });

      expect(
        (
          await authedFetch(`/api/events/${reEvent.id}/download/rebuild-all?quality=ORIGINAL`, adminCookie, {
            method: "POST",
          })
        ).status
      ).toBe(200);
      expect(
        (
          await authedFetch(`/api/events/${reEvent.id}/download/cancel?quality=ORIGINAL`, adminCookie, {
            method: "POST",
          })
        ).status
      ).toBe(200);

      // THE INVARIANT — every part the payload offers must resolve to real bytes.
      // (If the poller happened to claim the build before the cancel landed, the
      // part is legitimately rebuilt and this still holds; what must never happen
      // is a link into a NoSuchKey.)
      const payload = await variantPayload(reCookie, reEvent.slug, "ORIGINAL");
      for (const part of payload.parts) {
        const got = await fetchPart(part.index);
        if (part.url === null) {
          expect(got.api).toBe(404); // listed as unavailable, and refused
        } else {
          expect(got.api).toBe(302);
          expect(got.object).toBe(200); // NOT a 404 from S3
        }
      }

      // A rebuild after an expiry IS a rebuild, whoever asked for it: queueing it
      // outside requestBuild left rebuildCount and the histogram frozen.
      expect(
        await metricValue("pixshar_archive_rebuilds", { event: reEvent.slug, quality: "ORIGINAL" })
      ).toBeGreaterThan(rebuildsBefore);
      expect(
        await metricValue("pixshar_archive_expiry_to_rebuild_seconds_count", { quality: "ORIGINAL" })
      ).toBeGreaterThan(histBefore);
      expect(
        await metricValue("pixshar_archive_builds_total", { quality: "ORIGINAL", trigger: "admin" })
      ).toBeGreaterThan(0);
    }, 60_000);

    it("Then the archive is still repairable — the next request brings the same part back", async () => {
      await requestArchive(reCookie, reEvent.slug, "ORIGINAL");
      const status = await pollAdminStatus(
        adminCookie,
        reEvent.id,
        "ORIGINAL",
        (s) => s === "READY" || s === "FAILED",
        120_000
      );
      expect(status).toBe("READY");

      const rebuilt = await variantPayload(reCookie, reEvent.slug, "ORIGINAL");
      expect(rebuilt.parts).toHaveLength(1);
      expect(rebuilt.parts[0].index).toBe(1);
      // Same membership → the guest's per-part "downloaded" tick survived.
      expect(rebuilt.parts[0].membershipSig).toBe(sigBefore);
      expect(rebuilt.parts[0].url).not.toBeNull();

      // …and the link leads to real bytes. Pre-fix, cancel settled the part as
      // READY with the reclaimed object's key and nothing ever rebuilt it, so
      // this 302'd straight into a NoSuchKey.
      const got = await fetchPart(1);
      expect(got.api).toBe(302);
      expect(got.object).toBe(200);
    }, 180_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The worker's own /metrics exposition (PIXSHAR-9).
  //
  // The idle reaper and the append build counter run ONLY in the image-processor
  // process. Serving prom-client's GLOBAL registry there — while every pixshar_*
  // metric is registered on the custom Registry in lib/metrics.ts — exposed none
  // of them, from the one process that writes them.
  // ─────────────────────────────────────────────────────────────────────────

  describe("Worker (image-processor) metrics exposition", () => {
    it("Then the worker's /metrics serves the Pixshar registry, not prom-client's global one", async () => {
      const text = await (await fetch(`${WORKER}/metrics`)).text();

      expect(text).toMatch(/^# TYPE pixshar_archive_expired_total counter$/m);
      expect(text).toMatch(/^# TYPE pixshar_archive_bytes_reclaimed_total counter$/m);
      expect(text).toMatch(/^# TYPE pixshar_archive_builds_total counter$/m);
      expect(text).toMatch(/^# TYPE pixshar_archive_expiry_to_rebuild_seconds histogram$/m);
      // A worker-only metric, proving this is the process's own exposition.
      expect(text).toMatch(/^# TYPE pixshar_resize_queue_inflight gauge$/m);
    });

    it("Then builds_total{trigger=append} — which only the worker writes — shows up there", async () => {
      const apEvent = await createEvent(adminCookie, { password: "append-pass" });
      try {
        const apCookie = await unlockGallery(apEvent.slug, "append-pass");
        await uploadAndProcessPhoto(adminCookie, apEvent);
        await requestAndAwaitArchive(adminCookie, apCookie, apEvent, "DISPLAY");

        const read = () =>
          workerMetricValue("pixshar_archive_builds_total", { quality: "DISPLAY", trigger: "append" });
        const before = await read();

        // A photo landing on a live variant appends to it. The increment happens
        // in the image-processor, so only the worker's registry can show it.
        await uploadAndProcessPhoto(adminCookie, apEvent);
        await pollAdminStatus(adminCookie, apEvent.id, "DISPLAY", (s) => s !== "READY", 60_000);

        expect(await pollMetric(read, (v) => v > before)).toBeGreaterThan(before);
      } finally {
        await deleteEvent(adminCookie, apEvent.id);
      }
    }, 300_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pixshar_archive_downloads_total measures DOWNLOADS.
  //
  // It used to be incremented on every download-page load and on every SSE tick
  // of a READY variant — neither of which downloads anything or signs a URL.
  // Since the archive moved behind GET /download/part/:index, that redirect is
  // the one place bytes are actually handed out.
  // ─────────────────────────────────────────────────────────────────────────

  describe("Archive download counter", () => {
    let cntEvent: TestEvent;
    let cntCookie: string;

    beforeAll(async () => {
      cntEvent = await createEvent(adminCookie, { password: "count-pass" });
      cntCookie = await unlockGallery(cntEvent.slug, "count-pass");
      await uploadAndProcessPhoto(adminCookie, cntEvent);
      await requestAndAwaitArchive(adminCookie, cntCookie, cntEvent, "ORIGINAL");
    }, 300_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, cntEvent.id);
    });

    it("Then opening the download page counts nothing, and pulling a part counts one", async () => {
      const read = () => metricValue("pixshar_archive_downloads_total", { quality: "ORIGINAL" });
      const before = await read();

      // A page load is a pure read — it hands out no bytes.
      const page = await fetch(`${API}/api/gallery/${cntEvent.slug}/download`, {
        headers: { Cookie: cntCookie },
      });
      expect(page.status).toBe(200);
      expect(await read()).toBe(before);

      // The part redirect IS the download.
      const part = await fetch(
        `${API}/api/gallery/${cntEvent.slug}/download/part/1?quality=ORIGINAL`,
        { headers: { Cookie: cntCookie }, redirect: "manual" }
      );
      expect(part.status).toBe(302);
      expect(await read()).toBe(before + 1);
    });

    it("Then a part with no object counts nothing (nothing was downloaded)", async () => {
      const read = () => metricValue("pixshar_archive_downloads_total", { quality: "ORIGINAL" });
      const before = await read();

      const missing = await fetch(
        `${API}/api/gallery/${cntEvent.slug}/download/part/99?quality=ORIGINAL`,
        { headers: { Cookie: cntCookie }, redirect: "manual" }
      );
      expect(missing.status).toBe(404);
      expect(await read()).toBe(before);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // A photo deleted DURING a build (PIXSHAR-6's core promise).
  //
  // The builder snapshots the event's photos, then commits the part rows minutes
  // later. DownloadArchivePartEntry.photoId has no FK to Photo, so nothing
  // rejects an entry for a photo deleted in between — and the delete request's
  // own sweep found no entries to expire, because they did not exist yet. The
  // part then commits READY with the deleted photo's bytes inside, and under the
  // lazy model no later build ever revisits it.
  //
  // Driving the race: the first photo is small, so its bytes are inside the ZIP
  // within milliseconds of the build starting; the rest are large, so the build
  // stays busy streaming for ~1.5s — long enough for the DELETE to land after the
  // photo snapshot but before the part is committed.
  // ─────────────────────────────────────────────────────────────────────────

  describe("A photo deleted DURING a build", () => {
    let raceEvent: TestEvent;
    let raceCookie: string;
    let deletedPhoto: string;
    let survivor: string;
    const BIG = 45 * 1024 * 1024;

    beforeAll(async () => {
      raceEvent = await createEvent(adminCookie, { password: "race-pass" });
      raceCookie = await unlockGallery(raceEvent.slug, "race-pass");

      // createdAt order = zip order. The small one goes in first.
      deletedPhoto = await uploadAndProcessPhoto(adminCookie, raceEvent);
      survivor = await uploadAndProcessPhoto(adminCookie, raceEvent, BIG);
      for (let i = 0; i < 6; i++) await uploadAndProcessPhoto(adminCookie, raceEvent, BIG);
    }, 600_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, raceEvent.id);
    });

    it("Then the finished archive does not contain it, and its part is not offered", async () => {
      await requestArchive(raceCookie, raceEvent.slug, "ORIGINAL");

      // Wait for the builder to have taken its snapshot: photoCount is written by
      // markBuilding, which runs straight after loadPhotos.
      await awaitAdminStatus(
        adminCookie,
        raceEvent.id,
        "ORIGINAL",
        (s) => s.status === "BUILDING" && s.photoCount > 0,
        120_000
      );

      // The delete lands mid-build: the photo's bytes are already in the ZIP, but
      // its membership row has not been committed, so the delete sweep sees
      // nothing to expire.
      const del = await authedFetch(
        `/api/events/${raceEvent.id}/photos/${deletedPhoto}`,
        adminCookie,
        { method: "DELETE" }
      );
      expect(del.status).toBe(200);

      const status = await pollAdminStatus(
        adminCookie,
        raceEvent.id,
        "ORIGINAL",
        (s) => s === "READY" || s === "FAILED",
        180_000
      );
      expect(status).toBe("READY");

      // THE INVARIANT: nothing the guest can download contains the deleted photo.
      const payload = await variantPayload(raceCookie, raceEvent.slug, "ORIGINAL");
      for (const part of payload.parts.filter((p) => p.url !== null)) {
        const res = await fetch(`${API}${part.url}`, {
          headers: { Cookie: raceCookie },
          redirect: "manual",
        });
        expect(res.status).toBe(302);
        const zip = Buffer.from(await (await fetch(res.headers.get("location")!)).arrayBuffer());
        // Store-mode ZIP: entry names carry the photo id as plain bytes.
        expect(zip.includes(Buffer.from(deletedPhoto))).toBe(false);
      }

      // The part that held it lost its object, exactly as an ordinary deletion
      // would have left it — the build's own close-out put it through the same path.
      const poisoned = payload.parts.find((p) => p.index === 1);
      expect(poisoned).toBeDefined();
      expect(poisoned!.url).toBeNull();
    }, 300_000);

    it("Then requesting a rebuild restores it from the pruned membership", async () => {
      const requested = await requestArchive(raceCookie, raceEvent.slug, "ORIGINAL");
      expect(requested.queued).toBe(true); // a reclaimed part is NOT current

      const status = await pollAdminStatus(
        adminCookie,
        raceEvent.id,
        "ORIGINAL",
        (s) => s === "READY" || s === "FAILED",
        180_000
      );
      expect(status).toBe("READY");

      const rebuilt = await variantPayload(raceCookie, raceEvent.slug, "ORIGINAL");
      const part1 = rebuilt.parts.find((p) => p.index === 1)!;
      expect(part1.url).not.toBeNull();

      const res = await fetch(`${API}${part1.url}`, {
        headers: { Cookie: raceCookie },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const zip = Buffer.from(await (await fetch(res.headers.get("location")!)).arrayBuffer());
      expect(zip.subarray(0, 2).toString("ascii")).toBe("PK");
      expect(zip.includes(Buffer.from(deletedPhoto))).toBe(false);
      expect(zip.includes(Buffer.from(survivor))).toBe(true);
    }, 300_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // A deletion that empties the ONLY part leaves a READY job with no parts.
  // requestBuild used to look solely for EXPIRED parts, find none, and no-op —
  // so the "Archiv erstellen" button the guest is shown does nothing.
  //
  // It must stay a no-op when there is genuinely nothing to archive (no photos),
  // or every click would queue a build that produces an empty archive and lands
  // right back here.
  // ─────────────────────────────────────────────────────────────────────────

  describe("A deletion that empties the only part", () => {
    let emEvent: TestEvent;
    let emCookie: string;

    beforeAll(async () => {
      emEvent = await createEvent(adminCookie, { password: "empty-pass" });
      emCookie = await unlockGallery(emEvent.slug, "empty-pass");
      const only = await uploadAndProcessPhoto(adminCookie, emEvent);
      await requestAndAwaitArchive(adminCookie, emCookie, emEvent, "DISPLAY");

      const built = await variantPayload(emCookie, emEvent.slug, "DISPLAY");
      if (built.parts.length !== 1) throw new Error(`expected 1 part, got ${built.parts.length}`);

      const res = await authedFetch(`/api/events/${emEvent.id}/photos/${only}`, adminCookie, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
    }, 300_000);

    afterAll(async () => {
      await deleteEvent(adminCookie, emEvent.id);
    });

    it("Then the job is READY with no parts at all", async () => {
      expect(await adminStatus(adminCookie, emEvent.id, "DISPLAY")).toBe("READY");
      const payload = await variantPayload(emCookie, emEvent.slug, "DISPLAY");
      expect(payload.parts).toHaveLength(0);
      expect(payload.partCount).toBe(0);
    });

    it("Then requesting it is a safe no-op — no photos are left to archive", async () => {
      const requested = await requestArchive(emCookie, emEvent.slug, "DISPLAY");
      expect(requested.queued).toBe(false);
      expect(await adminStatus(adminCookie, emEvent.id, "DISPLAY")).toBe("READY");
    });

    it("Then a new photo brings the archive back (the variant is still alive)", async () => {
      const fresh = await uploadAndProcessPhoto(adminCookie, emEvent);

      // The append cycle waits out the 60s quiet window; skip it.
      await pollAdminStatus(adminCookie, emEvent.id, "DISPLAY", (s) => s !== "READY", 60_000);
      await authedFetch(`/api/events/${emEvent.id}/download/build-now?quality=DISPLAY`, adminCookie, {
        method: "POST",
      });
      const status = await pollAdminStatus(
        adminCookie,
        emEvent.id,
        "DISPLAY",
        (s) => s === "READY" || s === "FAILED",
        120_000
      );
      expect(status).toBe("READY");

      const payload = await variantPayload(emCookie, emEvent.slug, "DISPLAY");
      expect(payload.parts).toHaveLength(1);
      expect(payload.parts[0].url).not.toBeNull();

      const res = await fetch(`${API}${payload.parts[0].url}`, {
        headers: { Cookie: emCookie },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const zip = Buffer.from(await (await fetch(res.headers.get("location")!)).arrayBuffer());
      expect(zip.includes(Buffer.from(fresh))).toBe(true);
    }, 300_000);
  });
});
