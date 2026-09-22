import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  signInAdmin,
  createEvent,
  deleteEvent,
  unlockGallery,
  rpc,
  API,
  type TestEvent,
} from "./helpers.js";

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

  // ─── Info (oRPC) ─────────────────────────────────────────────────────────────

  describe("Given a gallery that exists", () => {
    describe("When calling gallery.info over RPC", () => {
      it("Then it returns the public event info", async () => {
        const res = await fetch(`${API}/api/rpc/gallery/info`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ json: { slug: event.slug } }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { json: { id: string; name: string } };
        expect(body.json.id).toBe(event.id);
        expect(body.json.name).toBeTruthy();
      });
    });
  });

  describe("Given a gallery slug that does not exist", () => {
    describe("When calling gallery.info over RPC", () => {
      it("Then it returns 404 with the NOT_FOUND code", async () => {
        const res = await fetch(`${API}/api/rpc/gallery/info`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ json: { slug: "does-not-exist-xyz" } }),
        });

        expect(res.status).toBe(404);
        const body = (await res.json()) as { json: { code: string } };
        expect(body.json.code).toBe("NOT_FOUND");
      });
    });
  });

  // ─── Unlock ──────────────────────────────────────────────────────────────────

  describe("Given a gallery protected by a password", () => {
    describe("When unlocking with the correct password", () => {
      it("Then it succeeds and sets a gallery session cookie", async () => {
        const res = await fetch(`${API}/api/rpc/gallery/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ json: { slug: event.slug, password: "gallery-secret" } }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { json: { success: boolean } };
        expect(body.json.success).toBe(true);

        const cookies = res.headers.getSetCookie();
        expect(cookies.find((c) => c.startsWith(`gallery_${event.slug}`))).toBeDefined();
      });
    });

    describe("When unlocking with a wrong password", () => {
      it("Then it fails with UNAUTHORIZED", async () => {
        await expect(
          rpc().gallery.unlock({ slug: event.slug, password: "wrong-password" }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      });
    });
  });

  describe("Given a gallery slug that does not exist", () => {
    describe("When unlocking", () => {
      it("Then it fails with NOT_FOUND", async () => {
        await expect(
          rpc().gallery.unlock({ slug: "does-not-exist-xyz", password: "anything" }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      });
    });
  });

  // ─── View ─────────────────────────────────────────────────────────────────────

  describe("Given a valid gallery session cookie", () => {
    describe("When calling gallery.get", () => {
      it("Then it returns the event with an empty photos array", async () => {
        const galleryCookie = await unlockGallery(event.slug, "gallery-secret");

        const data = await rpc(galleryCookie).gallery.get({ slug: event.slug });

        expect(data.slug).toBe(event.slug);
        expect(Array.isArray(data.photos)).toBe(true);
      });
    });
  });

  describe("Given no gallery session cookie", () => {
    describe("When calling gallery.get", () => {
      it("Then it fails with UNAUTHORIZED", async () => {
        await expect(rpc().gallery.get({ slug: event.slug })).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      });
    });
  });

  describe("Given a session cookie for a different gallery", () => {
    describe("When calling gallery.get for this gallery", () => {
      it("Then it fails with UNAUTHORIZED (cross-gallery session is not valid)", async () => {
        // Create a second event and use its cookie to access the first
        const other = await createEvent(adminCookie, { password: "other-pass" });
        const otherCookie = await unlockGallery(other.slug, "other-pass");
        await deleteEvent(adminCookie, other.id);

        await expect(rpc(otherCookie).gallery.get({ slug: event.slug })).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      });
    });
  });

  // ─── Rate limiting ───────────────────────────────────────────────────────────

  describe("Given an attacker brute-forcing the gallery password", () => {
    describe("When 6 wrong attempts are made in quick succession", () => {
      it("Then at least one attempt fails with TOO_MANY_REQUESTS", async () => {
        const client = rpc();
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            client.gallery.unlock({ slug: event.slug, password: "brute-force" }),
          ),
        );
        const codes = results.map((r) =>
          r.status === "rejected" ? (r.reason as { code?: string }).code : "ok",
        );

        expect(codes).toContain("TOO_MANY_REQUESTS");
      });
    });
  });
});
