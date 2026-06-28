/**
 * Shared helpers for API integration tests.
 * Tests run against the Docker Compose stack (localhost:3001).
 */
import { readFileSync } from "node:fs";

export const API = "http://localhost:3001";
export const ADMIN_EMAIL = "admin@example.com";
export const ADMIN_PASSWORD = "changeme";

// BetterAuth validates Origin against trustedOrigins — include it in every auth request.
export const ORIGIN_HEADERS = {
  "Content-Type": "application/json",
  Origin: "http://localhost:3000",
};

// globalSetup writes a single admin session here; each test file reads it.
export const ADMIN_COOKIE_PATH = "/tmp/pixshar-admin-cookie.txt";

// ─────────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the admin session cookie.
 * Reads from the cache written by globalSetup (avoids BetterAuth rate limits).
 * Falls back to a fresh sign-in if the cache file is missing.
 */
export async function signInAdmin(): Promise<string> {
  try {
    const cached = readFileSync(ADMIN_COOKIE_PATH, "utf-8").trim();
    if (cached) return cached;
  } catch {
    // cache miss — sign in fresh
  }

  const res = await fetch(`${API}/api/auth/sign-in/email`, {
    method: "POST",
    headers: ORIGIN_HEADERS,
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Admin sign-in failed: ${res.status}`);

  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookies) throw new Error("No session cookie returned");
  return cookies;
}

/** Performs an authenticated request against the API. */
export function authedFetch(
  path: string,
  cookie: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      ...(init.headers as Record<string, string>),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

let counter = 0;
/** Generates a unique slug safe for use as an event identifier in tests. */
export function uniqueSlug(prefix = "test"): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export interface TestEvent {
  id: string;
  slug: string;
  name: string;
}

/** Creates a test event via the API and returns its record. */
export async function createEvent(
  cookie: string,
  overrides: Partial<{ name: string; slug: string; description: string; password: string }> = {}
): Promise<TestEvent> {
  const slug = overrides.slug ?? uniqueSlug("evt");
  const body: Record<string, string> = {
    name: overrides.name ?? `Test Event ${slug}`,
    slug,
    password: overrides.password ?? "gallery-pass",
  };
  if (overrides.description !== undefined) body.description = overrides.description;

  const res = await authedFetch("/api/events", cookie, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createEvent failed ${res.status}: ${text}`);
  }
  // API returns the event object directly (not wrapped in { event: ... })
  return res.json() as Promise<TestEvent>;
}

/** Deletes a test event by ID. Silently ignores 404. */
export async function deleteEvent(cookie: string, id: string): Promise<void> {
  const res = await authedFetch(`/api/events/${id}`, cookie, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    console.warn(`deleteEvent(${id}) failed: ${res.status}`);
  }
}

/** Gets a gallery session cookie for a given slug + password. */
export async function unlockGallery(slug: string, password: string): Promise<string> {
  const res = await fetch(`${API}/api/gallery/${slug}/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`unlockGallery failed ${res.status}: ${body}`);
  }
  const galleryCookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return galleryCookie;
}
