import { test, expect } from "@playwright/test";
import {
  WEB,
  loginAsAdmin,
  apiSignIn,
  apiCreateEvent,
  apiDeleteEvent,
  uniqueSlug,
} from "./helpers.js";

test.describe("Event management", () => {
  // Single shared admin cookie — only one sign-in per file to avoid rate limits.
  let adminCookie: string;

  test.beforeAll(async () => {
    adminCookie = await apiSignIn();
  });

  // ─── Create event ─────────────────────────────────────────────────────────

  test.describe("Given an authenticated admin on the dashboard", () => {
    test.describe("When they click New Event and fill in valid details", () => {
      let eventId: string | null = null;
      const slug = uniqueSlug("new-evt");

      test.afterAll(async () => {
        if (eventId) await apiDeleteEvent(adminCookie, eventId);
      });

      test("Then the event is created and they land on the event detail page", async ({ page }) => {
        await loginAsAdmin(page);
        await page.getByRole("button", { name: /new event/i }).click();
        await expect(page).toHaveURL(/\/admin\/events\/new/, { timeout: 8_000 });

        // Fill in the form using placeholder selectors (labels are not associated via for/id)
        await page.getByPlaceholder("e.g. Marlowe & June").fill("E2E Test Event");
        await page.getByPlaceholder("slug").fill(slug);
        await page.getByPlaceholder("Guests enter this to unlock").fill("e2e-pass-123");

        await page.getByRole("button", { name: /create/i }).click();

        await expect(page).toHaveURL(/\/admin\/events\/[^/]+$/, { timeout: 12_000 });
        await expect(page).not.toHaveURL(/\/admin\/events\/new/);

        const url = page.url();
        const match = url.match(/\/admin\/events\/([^/?#]+)$/);
        if (match) eventId = match[1];

        await expect(page.getByText("E2E Test Event")).toBeVisible();
      });
    });
  });

  // ─── Admin dashboard shows events ─────────────────────────────────────────

  test.describe("Given the admin has an existing event", () => {
    test.describe("When they visit the admin dashboard", () => {
      let eventId: string;

      test.beforeAll(async () => {
        const ev = await apiCreateEvent(adminCookie, {
          name: "Dashboard Test Event",
          slug: uniqueSlug("dash"),
          password: "pass",
        });
        eventId = ev.id;
      });

      test.afterAll(async () => {
        await apiDeleteEvent(adminCookie, eventId);
      });

      test("Then the event appears on the dashboard with its name and photo count", async ({ page }) => {
        await loginAsAdmin(page);
        await expect(page.getByText("Dashboard Test Event")).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText(/photos/i).first()).toBeVisible();
      });
    });
  });

  // ─── Event detail page ────────────────────────────────────────────────────

  test.describe("Given an existing event", () => {
    test.describe("When the admin opens the event detail page", () => {
      let eventId: string;
      const slug = uniqueSlug("detail");

      test.beforeAll(async () => {
        const ev = await apiCreateEvent(adminCookie, {
          name: "Detail View Event",
          slug,
          password: "pass",
        });
        eventId = ev.id;
      });

      test.afterAll(async () => {
        await apiDeleteEvent(adminCookie, eventId);
      });

      test("Then they see the event info, share link, and an upload zone", async ({ page }) => {
        await loginAsAdmin(page);
        await page.goto(`${WEB}/admin/events/${eventId}`);

        await expect(page.getByText("Detail View Event")).toBeVisible({ timeout: 8_000 });
        await expect(page.getByText(new RegExp(slug))).toBeVisible();
        await expect(page.getByText(/upload|drag/i).first()).toBeVisible();
      });
    });
  });

  // ─── Delete event ─────────────────────────────────────────────────────────

  test.describe("Given an existing event on the admin event detail page", () => {
    test.describe("When the admin clicks Delete and confirms the browser dialog", () => {
      let eventId: string;
      const eventName = "Event To Delete";

      test.beforeAll(async () => {
        const ev = await apiCreateEvent(adminCookie, {
          name: eventName,
          slug: uniqueSlug("del"),
          password: "pass",
        });
        eventId = ev.id;
      });

      test("Then the event is removed and they are redirected to the dashboard", async ({ page }) => {
        await loginAsAdmin(page);
        await page.goto(`${WEB}/admin/events/${eventId}`);
        await expect(page.getByText(eventName)).toBeVisible({ timeout: 8_000 });

        // confirm() dialog is triggered by the Delete button — accept before it opens.
        page.on("dialog", (dialog) => dialog.accept());
        await page.getByRole("button", { name: /^delete$/i }).click();

        // Should redirect back to the admin dashboard (exact /admin, not /admin/events/...)
        await expect(page).toHaveURL(/\/admin$/, { timeout: 10_000 });
        await expect(page.getByText(eventName)).not.toBeVisible({ timeout: 6_000 });
      });
    });
  });
});
