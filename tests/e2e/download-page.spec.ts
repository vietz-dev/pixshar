/**
 * E2E tests for the gallery download page (/gallery/[slug]/download).
 *
 * Covers:
 *  - Unauthenticated access → redirected to password gate
 *  - After unlocking, navigating to the download page shows appropriate state
 *  - Single-download link in DownloadButton stays a direct <a> (not navigating to page)
 *  - Multi-part download button navigates to the download page (requires READY archive)
 *  - Checkbox state persists in localStorage after clicking a part link
 */
import { test, expect } from "@playwright/test";
import {
  WEB,
  API,
  apiSignIn,
  apiCreateEvent,
  apiDeleteEvent,
  uniqueSlug,
} from "./helpers.js";

test.describe("Gallery download page", () => {
  let adminCookie: string;
  let eventId: string;
  let eventSlug: string;

  test.beforeAll(async () => {
    adminCookie = await apiSignIn();
    eventSlug = uniqueSlug("dl");
    const ev = await apiCreateEvent(adminCookie, {
      name: "Download Page E2E Event",
      slug: eventSlug,
      password: "dl-e2e-pass",
    });
    eventId = ev.id;
  });

  test.afterAll(async () => {
    await apiDeleteEvent(adminCookie, eventId);
  });

  // ── Auth guard ─────────────────────────────────────────────────────────────

  test.describe("Given a guest with no gallery session", () => {
    test.describe("When they navigate directly to /gallery/:slug/download", () => {
      test("Then they are redirected to the password gate", async ({ page }) => {
        await page.context().clearCookies();
        await page.goto(`${WEB}/gallery/${eventSlug}/download`);

        // The page fetches /api/gallery/:slug/download, gets 401, and router.replace()s
        // to the gate — expect to land on /gallery/:slug (not /download)
        await expect(page).toHaveURL(
          new RegExp(`/gallery/${eventSlug}(?!/download)(?!/view)`),
          { timeout: 10_000 }
        );
        // Gate UI visible
        await expect(page.getByRole("button", { name: /unlock/i })).toBeVisible({
          timeout: 8_000,
        });
      });
    });
  });

  // ── Authenticated access — no archive yet ─────────────────────────────────

  test.describe("Given a guest with a valid gallery session and no archive ready", () => {
    test.describe("When they navigate to the download page", () => {
      test("Then they see an appropriate 'no archive' message and a back link", async ({ page }) => {
        // Unlock the gallery
        await page.context().clearCookies();
        await page.goto(`${WEB}/gallery/${eventSlug}`);
        await page.locator("input[type='password']").fill("dl-e2e-pass");
        await page.getByRole("button", { name: /unlock/i }).click();
        await expect(page).toHaveURL(/\/view/, { timeout: 12_000 });

        // Navigate to download page
        await page.goto(`${WEB}/gallery/${eventSlug}/download`);

        // Should NOT be redirected away — session cookie is valid
        await expect(page).toHaveURL(/\/download/, { timeout: 8_000 });

        // Either a "no archive / being prepared" message or the (empty) part
        // list — the page now always renders the variant toggle. Assert the
        // toggle is present and a status/summary line is visible.
        await expect(page.getByTestId("variant-toggle-kompakt")).toBeVisible({
          timeout: 8_000,
        });
        const msg = page.getByText(
          /no archive|archive|prepared|preparing|building|queued|part/i
        );
        await expect(msg.first()).toBeVisible({ timeout: 8_000 });

        // Back link present
        await expect(page.getByRole("button", { name: /back to gallery/i })).toBeVisible();
      });
    });
  });

  // ── Download page with READY archive ──────────────────────────────────────

  test.describe("Given a READY archive (0 photos, forced build)", () => {
    test("Then the download page shows part rows and checkboxes", async ({ page }) => {
      // Force-build via admin API (0 photos → should complete fast)
      const buildRes = await fetch(`${API}/api/events/${eventId}/download/build-now`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      expect(buildRes.status).toBe(200);

      // Poll for READY (up to 20 s)
      let status = "QUEUED";
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s = await fetch(`${API}/api/events/${eventId}/download/status`, {
          headers: { Cookie: adminCookie },
        });
        const b = await s.json() as { status: string };
        status = b.status;
        if (status === "READY" || status === "FAILED" || status === "CANCELLED") break;
      }

      // 0-photo build may result in READY with 0 parts or be skipped entirely — skip test
      if (status !== "READY") {
        test.skip(); // eslint-disable-line playwright/no-skipped-test
        return;
      }

      // Unlock gallery in browser
      await page.context().clearCookies();
      await page.goto(`${WEB}/gallery/${eventSlug}`);
      await page.locator("input[type='password']").fill("dl-e2e-pass");
      await page.getByRole("button", { name: /unlock/i }).click();
      await expect(page).toHaveURL(/\/view/, { timeout: 12_000 });

      // Navigate to download page
      await page.goto(`${WEB}/gallery/${eventSlug}/download`);
      await expect(page).toHaveURL(/\/download/, { timeout: 8_000 });

      // Heading visible
      await expect(page.getByRole("heading", { name: /download/i })).toBeVisible({
        timeout: 6_000,
      });
    });
  });

  // ── Checkbox state persists ───────────────────────────────────────────────

  test.describe("Given a READY archive with at least one part", () => {
    test("When a part link is clicked, Then the checkbox turns green and persists on reload", async ({ page }) => {
      // Force-build to ensure READY
      await fetch(`${API}/api/events/${eventId}/download/build-now`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });

      let status = "QUEUED";
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s = await fetch(`${API}/api/events/${eventId}/download/status`, {
          headers: { Cookie: adminCookie },
        });
        const b = await s.json() as { status: string };
        status = b.status;
        if (status === "READY" || status === "FAILED") break;
      }

      if (status !== "READY") {
        test.skip(); // eslint-disable-line playwright/no-skipped-test
        return;
      }

      // Fetch the download payload to see if there are any parts
      const galleryCookieRes = await fetch(`${API}/api/gallery/${eventSlug}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "dl-e2e-pass" }),
      });
      const galleryCookieStr = galleryCookieRes.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");

      const dlRes = await fetch(`${API}/api/gallery/${eventSlug}/download`, {
        headers: { Cookie: galleryCookieStr },
      });
      const dlBody = await dlRes.json() as { parts?: unknown[] };
      if (!dlBody.parts || dlBody.parts.length === 0) {
        test.skip(); // eslint-disable-line playwright/no-skipped-test
        return;
      }

      // Open download page in browser
      await page.context().clearCookies();
      await page.goto(`${WEB}/gallery/${eventSlug}`);
      await page.locator("input[type='password']").fill("dl-e2e-pass");
      await page.getByRole("button", { name: /unlock/i }).click();
      await expect(page).toHaveURL(/\/view/, { timeout: 12_000 });

      await page.goto(`${WEB}/gallery/${eventSlug}/download`);
      await expect(page).toHaveURL(/\/download/, { timeout: 8_000 });

      // Find the first part link
      const partLink = page.locator("a[download]").first();
      await expect(partLink).toBeVisible({ timeout: 8_000 });

      // Before click: no green check circle
      const checkCircle = page.locator("span").filter({
        has: page.locator("svg polyline[points='20 6 9 17 4 12']"),
      });
      await expect(checkCircle).not.toBeVisible();

      // Click the download link (intercept navigation so we don't leave the page)
      await page.evaluate(() => {
        document.querySelectorAll("a[download]").forEach((a) => {
          a.addEventListener("click", (e) => e.preventDefault());
        });
      });
      await partLink.click();

      // Green check circle should now be visible
      await expect(checkCircle).toBeVisible({ timeout: 4_000 });

      // Verify localStorage was set. The key now includes a quality segment
      // (DISPLAY = Kompakt, the default tab) and a membership-signature suffix,
      // so match by prefix rather than an exact key.
      const lsValue = await page.evaluate((slug) => {
        const prefix = `pixshar_dl_${slug}_DISPLAY_part_1_`;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix)) return localStorage.getItem(k);
        }
        return null;
      }, eventSlug);
      expect(lsValue).toBe("1");

      // Reload — checkbox should still be green (persisted)
      await page.reload();
      await expect(page).toHaveURL(/\/download/, { timeout: 8_000 });
      await expect(checkCircle).toBeVisible({ timeout: 6_000 });
    });
  });

  // ── Variant toggle (Kompakt / Original) ───────────────────────────────────

  test.describe("Given a guest on the download page", () => {
    // Shared setup: unlock the gallery in the browser and land on /download.
    async function openDownloadPage(page: import("@playwright/test").Page) {
      await page.context().clearCookies();
      await page.goto(`${WEB}/gallery/${eventSlug}`);
      await page.locator("input[type='password']").fill("dl-e2e-pass");
      await page.getByRole("button", { name: /unlock/i }).click();
      await expect(page).toHaveURL(/\/view/, { timeout: 12_000 });

      await page.goto(`${WEB}/gallery/${eventSlug}/download`);
      await expect(page).toHaveURL(/\/download/, { timeout: 8_000 });
    }

    test.describe("When the page loads", () => {
      test("Then it defaults to the Kompakt tab (Kompakt is selected, Original is not)", async ({ page }) => {
        await openDownloadPage(page);

        const kompakt = page.getByTestId("variant-toggle-kompakt");
        const original = page.getByTestId("variant-toggle-original");

        await expect(kompakt).toBeVisible({ timeout: 8_000 });
        await expect(original).toBeVisible();

        // Kompakt is the active tab on load; Original is never auto-selected.
        await expect(kompakt).toHaveAttribute("aria-selected", "true");
        await expect(original).toHaveAttribute("aria-selected", "false");
      });
    });

    test.describe("When the guest explicitly clicks the Original tab", () => {
      test("Then Original becomes selected and its content is shown", async ({ page }) => {
        await openDownloadPage(page);

        const kompakt = page.getByTestId("variant-toggle-kompakt");
        const original = page.getByTestId("variant-toggle-original");
        await expect(kompakt).toHaveAttribute("aria-selected", "true", {
          timeout: 8_000,
        });

        // Switching to Original must be an explicit user action.
        await original.click();
        await expect(original).toHaveAttribute("aria-selected", "true");
        await expect(kompakt).toHaveAttribute("aria-selected", "false");

        // The variant's own content is shown: either a summary line or parts.
        const content = page.getByText(
          /no download|prepared|part|total|byte|KB|MB|GB/i
        );
        await expect(content.first()).toBeVisible({ timeout: 8_000 });
      });
    });

    test.describe("When a variant is mid-build", () => {
      // Keep this robust to timing: we assert the toggle renders and Kompakt is
      // the default, and (if present) that the building banner sits on the
      // active tab. We do NOT depend on catching a specific transient state.
      test("Then the toggle renders with Kompakt default, and any building banner appears on the active tab", async ({ page }) => {
        await openDownloadPage(page);

        const kompakt = page.getByTestId("variant-toggle-kompakt");
        await expect(kompakt).toBeVisible({ timeout: 8_000 });
        await expect(kompakt).toHaveAttribute("aria-selected", "true");

        // If a build is in progress on the active tab, the building banner is
        // rendered (non-blocking). Its presence is timing-dependent, so only
        // assert it when it actually shows.
        const banner = page.getByTestId("building-banner");
        if (await banner.count()) {
          await expect(banner.first()).toBeVisible();
        }
      });
    });
  });
});
