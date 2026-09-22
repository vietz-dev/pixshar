/**
 * Shared helpers for API integration tests.
 * Tests run against the Docker Compose stack (localhost:3001).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { Contract } from "@pixshar/contracts";

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

/**
 * Typed oRPC client against the live API. Pass a session/gallery cookie to
 * authenticate; procedures assert their own access level server-side.
 */
export function rpc(cookie?: string): ContractRouterClient<Contract> {
  return createORPCClient(
    new RPCLink({
      url: `${API}/api/rpc`,
      headers: cookie ? { Cookie: cookie } : {},
    }),
  );
}

/** Performs an authenticated request against the API. */
export function authedFetch(
  path: string,
  cookie: string,
  init: RequestInit = {},
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
  overrides: Partial<{ name: string; slug: string; description: string; password: string }> = {},
): Promise<TestEvent> {
  const slug = overrides.slug ?? uniqueSlug("evt");
  return rpc(cookie).events.create({
    name: overrides.name ?? `Test Event ${slug}`,
    slug,
    password: overrides.password ?? "gallery-pass",
    description: overrides.description,
  });
}

/** Deletes a test event by ID. Silently ignores an already-deleted event. */
export async function deleteEvent(cookie: string, id: string): Promise<void> {
  await rpc(cookie)
    .events.delete({ id })
    .catch((err: unknown) => console.warn(`deleteEvent(${id}) failed: ${String(err)}`));
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

// ─────────────────────────────────────────────────────────────────────────────
// Photo upload + processing (drives the real image-processor + download jobs)
// ─────────────────────────────────────────────────────────────────────────────

// Minio, host-reachable (path-style). Presigned URLs sign the minio:9000
// hostname only reachable inside the Docker network, so tests PUT directly.
const testS3 = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  forcePathStyle: true,
});
const S3_BUCKET = "pixshar";

/** Valid 1×1 blue-pixel PNG — decodable by Bun.Image (so processing succeeds). */
function bluePng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
}

/**
 * Polls GET /api/upload/events/:id/photos/status until all pending work drains.
 * Throws on failure or timeout.
 */
export async function waitUntilProcessed(
  cookie: string,
  eventId: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await authedFetch(`/api/upload/events/${eventId}/photos/status`, cookie);
    const body = (await res.json()) as { pending: number; failed: number; total: number };
    if (body.total > 0 && body.pending === 0) {
      if (body.failed > 0) throw new Error(`${body.failed} photo(s) failed processing`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for image processing`);
}

/**
 * Uploads one admin photo to an event and waits until it is PROCESSED (so both
 * its display and original S3 objects exist). Returns the created photo id.
 * Each call uses distinct bytes so the fileHash is unique per event.
 */
let photoSeed = 0;
export async function uploadAndProcessPhoto(cookie: string, event: TestEvent): Promise<string> {
  // Make the bytes unique so the dedup constraint (eventId, fileHash) never trips.
  const base = bluePng();
  const bytes = Buffer.concat([base, Buffer.from(`pixshar-${Date.now()}-${photoSeed++}`)]);
  const fileHash = createHash("sha256").update(bytes).digest("hex");

  const initRes = await authedFetch(`/api/upload/events/${event.id}/photos/init`, cookie, {
    method: "POST",
    body: JSON.stringify({
      files: [
        {
          fileName: "dl-variant.png",
          ext: "png",
          contentType: "image/png",
          size: bytes.length,
          fileHash,
        },
      ],
    }),
  });
  if (!initRes.ok) throw new Error(`upload init failed ${initRes.status}: ${await initRes.text()}`);
  const { photos } = (await initRes.json()) as { photos: Array<{ id: string }> };
  const photoId = photos[0].id;

  await testS3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${event.id}/${photoId}/original.png`,
      Body: bytes,
      ContentType: "image/png",
    }),
  );

  const completeRes = await authedFetch(`/api/upload/events/${event.id}/photos/complete`, cookie, {
    method: "POST",
    body: JSON.stringify({ photoIds: [photoId] }),
  });
  if (completeRes.status !== 202) {
    throw new Error(`upload complete failed ${completeRes.status}: ${await completeRes.text()}`);
  }

  await waitUntilProcessed(cookie, event.id);
  return photoId;
}
