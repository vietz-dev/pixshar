import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  signInAdmin,
  authedFetch,
  createEvent,
  deleteEvent,
  uniqueSlug,
  type TestEvent,
} from "./helpers.js";

describe("Event Management", () => {
  let adminCookie: string;
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    adminCookie = await signInAdmin();
  });

  afterAll(async () => {
    await Promise.all(createdEventIds.map((id) => deleteEvent(adminCookie, id)));
  });

  // ─── List ────────────────────────────────────────────────────────────────────

  describe("Given an authenticated admin", () => {
    describe("When listing events via GET /api/events", () => {
      it("Then it returns 200 with an array of events", async () => {
        const res = await authedFetch("/api/events", adminCookie);

        expect(res.status).toBe(200);
        const body = await res.json() as unknown[];
        expect(Array.isArray(body)).toBe(true);
      });
    });
  });

  // ─── Create ──────────────────────────────────────────────────────────────────

  describe("Given an authenticated admin with valid event details", () => {
    describe("When creating an event via POST /api/events", () => {
      it("Then it returns 201 with the new event including id and slug", async () => {
        const slug = uniqueSlug("create");
        const res = await authedFetch("/api/events", adminCookie, {
          method: "POST",
          body: JSON.stringify({
            name: "Summer Gala 2026",
            slug,
            description: "A test event",
            password: "secret123",
          }),
        });

        expect(res.status).toBe(201);
        const event = await res.json() as TestEvent;
        expect(event.slug).toBe(slug);
        expect(event.name).toBe("Summer Gala 2026");
        expect(event).toHaveProperty("id");

        createdEventIds.push(event.id);
      });
    });
  });

  describe("Given a slug that is already taken", () => {
    describe("When creating a second event with the same slug", () => {
      it("Then it returns 409 Conflict", async () => {
        const slug = uniqueSlug("dup");
        const event = await createEvent(adminCookie, { slug });
        createdEventIds.push(event.id);

        const res = await authedFetch("/api/events", adminCookie, {
          method: "POST",
          body: JSON.stringify({ name: "Duplicate", slug, password: "x" }),
        });

        expect(res.status).toBe(409);
      });
    });
  });

  describe("Given a slug with uppercase letters", () => {
    describe("When creating an event", () => {
      it("Then it returns 400 Bad Request (slug must be lowercase)", async () => {
        const res = await authedFetch("/api/events", adminCookie, {
          method: "POST",
          body: JSON.stringify({ name: "Bad Slug", slug: "Has-Uppercase", password: "x" }),
        });

        expect(res.status).toBe(400);
      });
    });
  });

  // ─── Get ─────────────────────────────────────────────────────────────────────

  describe("Given an existing event", () => {
    describe("When fetching it via GET /api/events/:id", () => {
      it("Then it returns 200 with the event's photos array", async () => {
        const event = await createEvent(adminCookie);
        createdEventIds.push(event.id);

        const res = await authedFetch(`/api/events/${event.id}`, adminCookie);

        expect(res.status).toBe(200);
        const body = await res.json() as { photos: unknown[] };
        expect(Array.isArray(body.photos)).toBe(true);
      });
    });
  });

  describe("Given a non-existent event ID", () => {
    describe("When fetching via GET /api/events/:id", () => {
      it("Then it returns 404", async () => {
        const res = await authedFetch("/api/events/nonexistent-id-xyz", adminCookie);
        expect(res.status).toBe(404);
      });
    });
  });

  // ─── Delete ──────────────────────────────────────────────────────────────────

  describe("Given an existing event owned by the admin", () => {
    describe("When deleting it via DELETE /api/events/:id", () => {
      it("Then it returns 200 and the event is no longer fetchable", async () => {
        const event = await createEvent(adminCookie);

        const delRes = await authedFetch(`/api/events/${event.id}`, adminCookie, {
          method: "DELETE",
        });
        expect(delRes.status).toBe(200);

        const getRes = await authedFetch(`/api/events/${event.id}`, adminCookie);
        expect(getRes.status).toBe(404);
      });
    });
  });

  // ─── Auth guard ──────────────────────────────────────────────────────────────

  describe("Given no session cookie", () => {
    describe("When calling any event endpoint", () => {
      it("Then it returns 401 Unauthorized", async () => {
        const res = await fetch("http://localhost:3001/api/events");
        expect(res.status).toBe(401);
      });
    });
  });
});
