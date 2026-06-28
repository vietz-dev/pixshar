import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  signInAdmin,
  authedFetch,
  createEvent,
  deleteEvent,
  unlockGallery,
  type TestEvent,
} from "./helpers.js";
import { API } from "./helpers.js";

describe("Gallery", () => {
  let adminCookie: string;
  let event: TestEvent;

  beforeAll(async () => {
    adminCookie = await signInAdmin();
    event = await createEvent(adminCookie, { password: "gallery-secret" });
  });

  afterAll(async () => {
    await deleteEvent(adminCookie, event.id);
  });

  // ─── Unlock ──────────────────────────────────────────────────────────────────

  describe("Given a gallery protected by a password", () => {
    describe("When unlocking with the correct password", () => {
      it("Then it returns 200 and sets a gallery session cookie", async () => {
        const res = await fetch(`${API}/api/gallery/${event.slug}/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "gallery-secret" }),
        });

        expect(res.status).toBe(200);
        const body = await res.json() as { success: boolean };
        expect(body.success).toBe(true);

        const cookies = res.headers.getSetCookie();
        const galleryCookie = cookies.find((c) => c.startsWith(`gallery_${event.slug}`));
        expect(galleryCookie).toBeDefined();
      });
    });

    describe("When unlocking with a wrong password", () => {
      it("Then it returns 401 Unauthorized", async () => {
        const res = await fetch(`${API}/api/gallery/${event.slug}/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "wrong-password" }),
        });

        expect(res.status).toBe(401);
        const body = await res.json() as { error: string };
        expect(body.error).toMatch(/invalid/i);
      });
    });
  });

  describe("Given a gallery slug that does not exist", () => {
    describe("When unlocking", () => {
      it("Then it returns 404", async () => {
        const res = await fetch(`${API}/api/gallery/does-not-exist-xyz/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "anything" }),
        });

        expect(res.status).toBe(404);
      });
    });
  });

  // ─── View ─────────────────────────────────────────────────────────────────────

  describe("Given a valid gallery session cookie", () => {
    describe("When fetching the gallery via GET /api/gallery/:slug", () => {
      it("Then it returns 200 with event data and an empty photos array", async () => {
        const galleryCookie = await unlockGallery(event.slug, "gallery-secret");

        const res = await fetch(`${API}/api/gallery/${event.slug}`, {
          headers: { Cookie: galleryCookie },
        });

        expect(res.status).toBe(200);
        const body = await res.json() as { slug: string; photos: unknown[] };
        expect(body.slug).toBe(event.slug);
        expect(Array.isArray(body.photos)).toBe(true);
      });
    });
  });

  describe("Given no gallery session cookie", () => {
    describe("When fetching the gallery", () => {
      it("Then it returns 401 requiring a session", async () => {
        const res = await fetch(`${API}/api/gallery/${event.slug}`);
        expect(res.status).toBe(401);
      });
    });
  });

  describe("Given a session cookie for a different gallery", () => {
    describe("When fetching this gallery", () => {
      it("Then it returns 401 (cross-gallery session is not valid)", async () => {
        // Create a second event and use its cookie to access the first
        const other = await createEvent(adminCookie, { password: "other-pass" });
        const otherCookie = await unlockGallery(other.slug, "other-pass");
        await deleteEvent(adminCookie, other.id);

        const res = await fetch(`${API}/api/gallery/${event.slug}`, {
          headers: { Cookie: otherCookie },
        });
        expect(res.status).toBe(401);
      });
    });
  });

  // ─── Rate limiting ───────────────────────────────────────────────────────────

  describe("Given an attacker brute-forcing the gallery password", () => {
    describe("When 6 wrong attempts are made in quick succession", () => {
      it("Then the 6th attempt returns 429 Too Many Requests", async () => {
        const slug = event.slug;
        const attempts = Array.from({ length: 6 }, () =>
          fetch(`${API}/api/gallery/${slug}/unlock`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "brute-force" }),
          })
        );
        const results = await Promise.all(attempts);
        const statuses = results.map((r) => r.status);

        // At least one response must be 429 (rate limiter kicks in)
        expect(statuses).toContain(429);
      });
    });
  });
});
