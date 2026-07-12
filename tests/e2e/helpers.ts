import { createHash } from "node:crypto";
import { type Page, expect } from "@playwright/test";

export const WEB = "http://localhost:3000";
export const API = "http://localhost:3001";
export const ADMIN_EMAIL = "admin@example.com";
export const ADMIN_PASSWORD = "changeme";

// ─────────────────────────────────────────────────────────────────────────────
// Unique slug helper
// ─────────────────────────────────────────────────────────────────────────────

let counter = 0;
export function uniqueSlug(prefix = "e2e"): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin login
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigates to the admin dashboard, relying on the pre-loaded storage state.
 * The playwright.config.ts sets storageState for all tests, so no sign-in form
 * is needed — we just navigate directly to /admin.
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${WEB}/admin`);
  await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });
}

/**
 * Signs in through the login form UI (for tests that need to exercise the form).
 * Note: the login page uses unassociated <label> elements — target inputs by type.
 */
export async function loginViaForm(
  page: Page,
  email = ADMIN_EMAIL,
  password = ADMIN_PASSWORD
): Promise<void> {
  await page.goto(`${WEB}/auth/login`);
  await page.locator("input[type='email']").fill(email);
  await page.locator("input[type='password']").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
}

// ─────────────────────────────────────────────────────────────────────────────
// API helpers (for test fixture setup / teardown without going through the UI)
// ─────────────────────────────────────────────────────────────────────────────

export async function apiSignIn(): Promise<string> {
  // Retry once after a short delay to recover from BetterAuth rate limiting.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000 * attempt));

    const res = await fetch(`${API}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: WEB },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });

    if (res.ok) {
      const cookies = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      if (cookies) return cookies;
    }

    if (res.status !== 429) {
      throw new Error(`apiSignIn failed: ${res.status} ${await res.text()}`);
    }
    // 429 → retry after delay
  }
  throw new Error("apiSignIn: exhausted retries due to rate limiting");
}

export async function apiCreateEvent(
  cookie: string,
  opts: { name: string; slug: string; password: string }
): Promise<{ id: string; slug: string }> {
  const res = await fetch(`${API}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`apiCreateEvent failed ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiDeleteEvent(cookie: string, id: string): Promise<void> {
  await fetch(`${API}/api/events/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
}

/**
 * Upload one photo through the real presigned-PUT flow (init → PUT to S3 →
 * complete) and wait until the image processor has finished with it, so an
 * archive built afterwards actually has a photo to pack into a part.
 *
 * The presigned URL points at S3_PUBLIC_ENDPOINT (localhost:9000), which is
 * reachable from the test process — the same URL the browser would PUT to.
 */
let photoSeed = 0;
export async function apiUploadPhoto(cookie: string, eventId: string): Promise<string> {
  // 1×1 PNG + a unique tail so the (eventId, fileHash) dedup constraint never trips.
  const base = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const bytes = Buffer.concat([base, Buffer.from(`pixshar-e2e-${Date.now()}-${photoSeed++}`)]);
  const fileHash = createHash("sha256").update(bytes).digest("hex");

  const initRes = await fetch(`${API}/api/upload/events/${eventId}/photos/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      files: [
        { fileName: "e2e.png", ext: "png", contentType: "image/png", size: bytes.length, fileHash },
      ],
    }),
  });
  if (!initRes.ok) throw new Error(`upload init failed ${initRes.status}: ${await initRes.text()}`);
  const { photos } = (await initRes.json()) as {
    photos: Array<{ id: string; uploadUrl: string }>;
  };
  const photo = photos[0];

  const put = await fetch(photo.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: bytes,
  });
  if (!put.ok) throw new Error(`S3 PUT failed ${put.status}`);

  const done = await fetch(`${API}/api/upload/events/${eventId}/photos/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ photoIds: [photo.id] }),
  });
  if (done.status !== 202) throw new Error(`upload complete failed ${done.status}`);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/api/upload/events/${eventId}/photos/status`, {
      headers: { Cookie: cookie },
    });
    const body = (await res.json()) as { pending: number; failed: number; total: number };
    if (body.total > 0 && body.pending === 0) {
      if (body.failed > 0) throw new Error(`${body.failed} photo(s) failed processing`);
      return photo.id;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Timed out waiting for image processing");
}
