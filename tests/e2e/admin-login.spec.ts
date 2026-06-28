import { test, expect } from "@playwright/test";
import { WEB, ADMIN_EMAIL, ADMIN_PASSWORD, loginViaForm } from "./helpers.js";

/**
 * These tests exercise the login form UI and therefore clear cookies first
 * (the project-level storageState would skip the form by going directly to /admin).
 */
test.describe("Admin login", () => {
  test.describe("Given the login page (unauthenticated)", () => {
    // Clear admin storage state so we actually see the login page.
    test.use({ storageState: { cookies: [], origins: [] } });

    test.beforeEach(async ({ page }) => {
      await page.goto(`${WEB}/auth/login`);
    });

    test.describe("When a visitor lands on the login page", () => {
      test("Then they see the Pixshar login form with email and password fields", async ({ page }) => {
        await expect(page.locator("input[type='email']")).toBeVisible();
        await expect(page.locator("input[type='password']")).toBeVisible();
        await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
      });
    });

    test.describe("When an admin submits valid credentials via the login form", () => {
      test("Then they are redirected to the admin dashboard", async ({ page }) => {
        await loginViaForm(page, ADMIN_EMAIL, ADMIN_PASSWORD);

        await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });
        await expect(page.getByText(/events/i).first()).toBeVisible();
      });
    });

    test.describe("When an admin submits wrong credentials", () => {
      test("Then they see an error message and stay on the login page", async ({ page }) => {
        await loginViaForm(page, ADMIN_EMAIL, "wrong-password");

        await expect(page.locator("input[type='email']")).toBeVisible();
        // BetterAuth returns "Invalid email or password" (or similar)
        await expect(
          page.locator("text=/invalid|incorrect|failed|unauthorized/i").first()
        ).toBeVisible({ timeout: 8_000 });
      });
    });
  });

  test.describe("Given an unauthenticated visitor", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test.describe("When they navigate directly to the admin dashboard", () => {
      test("Then they are redirected to the login page", async ({ page }) => {
        await page.goto(`${WEB}/admin`);
        await expect(page).toHaveURL(/\/auth\/login/, { timeout: 10_000 });
      });
    });
  });
});
