import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ORPCError } from "@orpc/client";
import { signInAdmin, rpc, createEvent, deleteEvent, uniqueSlug } from "./helpers.js";

/** Runs `fn`, expecting it to reject with an ORPCError, and returns that error. */
async function expectORPCError(fn: () => Promise<unknown>): Promise<ORPCError<string, unknown>> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ORPCError) return err;
    throw err;
  }
  throw new Error("Expected the call to reject with an ORPCError");
}

describe("Event Management", () => {
  let adminCookie: string;
  let api: ReturnType<typeof rpc>;
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    adminCookie = await signInAdmin();
    api = rpc(adminCookie);
  });

  afterAll(async () => {
    await Promise.all(createdEventIds.map((id) => deleteEvent(adminCookie, id)));
  });

  // ─── List ────────────────────────────────────────────────────────────────────

  describe("Given an authenticated admin", () => {
    describe("When calling events.list", () => {
      it("Then it returns an array of events", async () => {
        const events = await api.events.list({});

        expect(Array.isArray(events)).toBe(true);
      });
    });
  });

  // ─── Create ──────────────────────────────────────────────────────────────────

  describe("Given an authenticated admin with valid event details", () => {
    describe("When calling events.create", () => {
      it("Then it returns the new event including id and slug", async () => {
        const slug = uniqueSlug("create");
        const event = await api.events.create({
          name: "Summer Gala 2026",
          slug,
          description: "A test event",
          password: "secret123",
        });

        expect(event.slug).toBe(slug);
        expect(event.name).toBe("Summer Gala 2026");
        expect(event).toHaveProperty("id");

        createdEventIds.push(event.id);
      });
    });
  });

  describe("Given a slug that is already taken", () => {
    describe("When creating a second event with the same slug", () => {
      it("Then it fails with CONFLICT (409)", async () => {
        const slug = uniqueSlug("dup");
        const event = await createEvent(adminCookie, { slug });
        createdEventIds.push(event.id);

        const err = await expectORPCError(() =>
          api.events.create({ name: "Duplicate", slug, password: "x" }),
        );

        expect(err.code).toBe("CONFLICT");
        expect(err.status).toBe(409);
      });
    });
  });

  describe("Given a slug with uppercase letters", () => {
    describe("When creating an event", () => {
      it("Then it fails input validation with BAD_REQUEST (slug must be lowercase)", async () => {
        const err = await expectORPCError(() =>
          api.events.create({ name: "Bad Slug", slug: "Has-Uppercase", password: "x" }),
        );

        expect(err.status).toBe(400);
      });
    });
  });

  // ─── Get ─────────────────────────────────────────────────────────────────────

  describe("Given an existing event", () => {
    describe("When calling events.get", () => {
      it("Then it returns the event's photos array", async () => {
        const event = await createEvent(adminCookie);
        createdEventIds.push(event.id);

        const detail = await api.events.get({ id: event.id });

        expect(Array.isArray(detail.photos)).toBe(true);
      });
    });
  });

  describe("Given a non-existent event ID", () => {
    describe("When calling events.get", () => {
      it("Then it fails with NOT_FOUND (404)", async () => {
        const err = await expectORPCError(() => api.events.get({ id: "nonexistent-id-xyz" }));

        expect(err.code).toBe("NOT_FOUND");
        expect(err.status).toBe(404);
      });
    });
  });

  // ─── Password ────────────────────────────────────────────────────────────────

  describe("Given an existing event owned by the admin", () => {
    describe("When calling events.setPassword", () => {
      it("Then the new password is readable back from events.get", async () => {
        const event = await createEvent(adminCookie);
        createdEventIds.push(event.id);

        await api.events.setPassword({ id: event.id, password: "rotated-pass" });

        const detail = await api.events.get({ id: event.id });
        expect(detail.password).toBe("rotated-pass");
      });
    });
  });

  // ─── Delete ──────────────────────────────────────────────────────────────────

  describe("Given an existing event owned by the admin", () => {
    describe("When calling events.delete", () => {
      it("Then the event is no longer fetchable", async () => {
        const event = await createEvent(adminCookie);

        await api.events.delete({ id: event.id });

        const err = await expectORPCError(() => api.events.get({ id: event.id }));
        expect(err.code).toBe("NOT_FOUND");
      });
    });
  });

  // ─── Auth guard ──────────────────────────────────────────────────────────────

  describe("Given no session cookie", () => {
    describe("When calling any event procedure", () => {
      it("Then it fails with UNAUTHORIZED (401)", async () => {
        const err = await expectORPCError(() => rpc().events.list({}));

        expect(err.code).toBe("UNAUTHORIZED");
        expect(err.status).toBe(401);
      });
    });
  });
});
