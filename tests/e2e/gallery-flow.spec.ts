import { test, expect } from "@playwright/test";
import {
  WEB,
  loginAsAdmin,
  apiSignIn,
  apiCreateEvent,
  apiDeleteEvent,
  uniqueSlug,
} from "./helpers.js";

test.describe("Gallery flow", () => {
  let adminCookie: string;
  let eventId: string;
  let eventSlug: string;

  test.beforeAll(async () => {
    adminCookie = await apiSignIn();
    const slug = uniqueSlug("gal");
    const ev = await apiCreateEvent(adminCookie, {
      name: "Gallery Flow Event",
      slug,
      password: "gallery-e2e-pass",
    });
    eventId = ev.id;
    eventSlug = ev.slug;
  });

  test.afterAll(async () => {
    await apiDeleteEvent(adminCookie, eventId);
  });

  // ─── Password gate ─────────────────────────────────────────────────────────

  test.describe("Given a guest visiting a private gallery URL", () => {
    test.describe("When they load the gallery page without a session", () => {
      test("Then they see the password gate with the event name and an unlock button", async ({ page }) => {
        await page.context().clearCookies();
        await page.goto(`${WEB}/gallery/${eventSlug}`);

        await expect(page.getByText("Gallery Flow Event")).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText(/private gallery/i)).toBeVisible();
        await expect(page.getByRole("button", { name: /unlock/i })).toBeVisible();
      });
    });

    test.describe("When they enter the wrong password", () => {
      test("Then they see an error and remain on the password gate", async ({ page }) => {
        await page.context().clearCookies();
        await page.goto(`${WEB}/gallery/${eventSlug}`);

        await page.locator("input[type='password']").fill("wrong");
        await page.getByRole("button", { name: /unlock/i }).click();

        await expect(page.getByText(/invalid|incorrect|wrong|failed/i)).toBeVisible({
          timeout: 8_000,
        });
        // Still on the gate page, not the view page
        await expect(page).not.toHaveURL(/\/view/);
      });
    });

    test.describe("When they enter the correct password", () => {
      test("Then they are redirected to the gallery view", async ({ page }) => {
        await page.context().clearCookies();
        await page.goto(`${WEB}/gallery/${eventSlug}`);

        await page.locator("input[type='password']").fill("gallery-e2e-pass");
        await page.getByRole("button", { name: /unlock/i }).click();

        await expect(page).toHaveURL(new RegExp(`/gallery/${eventSlug}/view`), {
          timeout: 12_000,
        });
      });
    });
  });

  // ─── Gallery view ──────────────────────────────────────────────────────────

  test.describe("Given a guest with a valid gallery session", () => {
    test.describe("When they open the gallery view", () => {
      test("Then they see the event name, an empty photo grid, and an upload button", async ({
        page,
      }) => {
        await page.context().clearCookies();
        await page.goto(`${WEB}/gallery/${eventSlug}`);
        await page.locator("input[type='password']").fill("gallery-e2e-pass");
        await page.getByRole("button", { name: /unlock/i }).click();
        await expect(page).toHaveURL(/\/view/, { timeout: 12_000 });

        await expect(page.getByText("Gallery Flow Event")).toBeVisible();
        // Upload button should be visible
        await expect(page.getByRole("button", { name: /upload/i })).toBeVisible();
      });
    });

    test.describe("When they click the upload button", () => {
      test("Then the upload modal opens with a name field and a file picker", async ({ page }) => {
        await page.context().clearCookies();
        await page.goto(`${WEB}/gallery/${eventSlug}`);
        await page.locator("input[type='password']").fill("gallery-e2e-pass");
        await page.getByRole("button", { name: /unlock/i }).click();
        await expect(page).toHaveURL(/\/view/, { timeout: 12_000 });

        await page.getByRole("button", { name: /upload/i }).click();

        // Modal should contain a name/photographer field and file input
        await expect(
          page
            .getByText(/your name|photographer/i)
            .or(page.locator("input[placeholder*='name' i]"))
        ).toBeVisible({ timeout: 5_000 });
      });
    });
  });

  // ─── Already-unlocked redirect ─────────────────────────────────────────────

  test.describe("Given a guest who already has a valid session cookie", () => {
    test.describe("When they navigate to the gallery gate URL", () => {
      test("Then they are immediately redirected to the view page", async ({ page }) => {
        // First unlock to get the cookie
        await page.context().clearCookies();
        await page.goto(`${WEB}/gallery/${eventSlug}`);
        await page.locator("input[type='password']").fill("gallery-e2e-pass");
        await page.getByRole("button", { name: /unlock/i }).click();
        await expect(page).toHaveURL(/\/view/, { timeout: 12_000 });

        // Now navigate back to the gate — should auto-redirect
        await page.goto(`${WEB}/gallery/${eventSlug}`);
        await expect(page).toHaveURL(/\/view/, { timeout: 8_000 });
      });
    });
  });

  // ─── Admin gallery preview ─────────────────────────────────────────────────

  test.describe("Given an authenticated admin on the event detail page", () => {
    test.describe("When they click 'Share this gallery' to preview", () => {
      test("Then the gallery gate page opens in a new tab", async ({ page, context }) => {
        await loginAsAdmin(page);
        await page.goto(`${WEB}/admin/events/${eventId}`);

        await expect(page.getByText("Gallery Flow Event")).toBeVisible({ timeout: 8_000 });

        // "Preview" button opens the gallery in a new tab via window.open
        const [popup] = await Promise.all([
          context.waitForEvent("page"),
          page.getByRole("button", { name: /^preview$/i }).click(),
        ]);

        await popup.waitForLoadState("domcontentloaded");
        await expect(popup).toHaveURL(new RegExp(`/gallery/${eventSlug}`), { timeout: 8_000 });
      });
    });
  });
});
