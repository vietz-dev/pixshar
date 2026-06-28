/**
 * Playwright global setup: logs in once and saves browser storage state.
 * All tests that need an authenticated admin context load this state
 * instead of signing in each time, avoiding BetterAuth rate limits.
 */
import { chromium } from "@playwright/test";
import path from "node:path";

export const ADMIN_STATE_PATH = path.resolve("tests/e2e/.auth/admin.json");

export default async function globalSetup() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto("http://localhost:3000/auth/login");
  await page.locator("input[type='email']").fill("admin@example.com");
  await page.locator("input[type='password']").fill("changeme");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/, { timeout: 15_000 });

  await page.context().storageState({ path: ADMIN_STATE_PATH });
  await browser.close();
}
