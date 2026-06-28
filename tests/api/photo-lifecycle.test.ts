/**
 * End-to-end photo lifecycle tests — verifies that data actually flows through
 * every layer (API → S3 upload → image-processor → gallery) and is correctly
 * cleaned up on delete.
 *
 * Phases run in strict order, sharing state through outer variables:
 *   1. Admin uploads a photo (init → PUT to S3 → complete)
 *   2. Image processor runs → photo becomes PROCESSED (S3 thumb + display created)
 *   3. Guest can see the processed photo in the gallery
 *   4. Guest uploads their own photo → also visible in gallery
 *   5. Admin deletes the admin photo → gone from API + S3 objects removed
 *   6. Admin deletes the entire event → 404 + all remaining S3 objects removed
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  API,
  signInAdmin,
  authedFetch,
  createEvent,
  deleteEvent,
  unlockGallery,
  type TestEvent,
} from "./helpers.js";

// ─── S3 test client (Minio, path-style, host-accessible) ─────────────────────

const testS3 = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  forcePathStyle: true,
});
const S3_BUCKET = "pixshar";

async function s3ObjectExists(key: string): Promise<boolean> {
  try {
    await testS3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function putToS3(key: string, body: Buffer, contentType = "image/jpeg"): Promise<void> {
  await testS3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Valid 1×1 blue-pixel PNG — confirmed decodable by Bun.Image. */
function bluePng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
}

/** Valid 1×1 white-pixel PNG — different bytes from bluePng() for distinct hash. */
function whitePng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",
    "base64"
  );
}

/**
 * Polls GET /api/upload/events/:id/photos/status until pending === 0.
 * Throws if processing fails or times out.
 */
async function waitUntilProcessed(cookie: string, eventId: string, timeoutMs: number): Promise<void> {
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Photo lifecycle", () => {
  let adminCookie: string;
  let event: TestEvent;

  // Phase-level shared state (set in beforeAll, read in it/later beforeAll blocks)
  let adminPhotoId: string;
  let adminOriginalKey: string;
  let adminThumbKey: string;
  let adminDisplayKey: string;
  let guestPhotoId: string;
  let guestThumbKey: string;
  let guestDisplayKey: string;
  let guestOriginalKey: string;

  beforeAll(async () => {
    adminCookie = await signInAdmin();
    event = await createEvent(adminCookie, {
      name: "Lifecycle Test Event",
      password: "lifecycle-pass",
    });
  }, 30_000);

  afterAll(async () => {
    // Best-effort: already deleted in Phase 6, but guard against test failures
    await deleteEvent(adminCookie, event.id).catch(() => {});
  });

  // ─── Phase 1: Admin upload ────────────────────────────────────────────────

  describe("Phase 1 — Given an admin with a new event", () => {
    const jpeg = bluePng();
    const fileHash = sha256(jpeg);

    beforeAll(async () => {
      // Step 1: init
      const initRes = await authedFetch(
        `/api/upload/events/${event.id}/photos/init`,
        adminCookie,
        {
          method: "POST",
          body: JSON.stringify({
            files: [
              {
                fileName: "admin-photo.png",
                ext: "png",
                contentType: "image/png",
                size: jpeg.length,
                fileHash,
              },
            ],
          }),
        }
      );
      expect(initRes.status).toBe(200);
      const { photos } = (await initRes.json()) as { photos: Array<{ id: string; duplicate: boolean }> };
      adminPhotoId = photos[0].id;
      adminOriginalKey = `${event.id}/${adminPhotoId}/original.png`;

      // Step 2: PUT bytes directly to Minio (presigned URL uses minio:9000 hostname,
      // only reachable inside the Docker network; the test host uses localhost:9000).
      await putToS3(adminOriginalKey, jpeg, "image/png");

      // Step 3: complete — wakes the image-processor worker
      const completeRes = await authedFetch(
        `/api/upload/events/${event.id}/photos/complete`,
        adminCookie,
        {
          method: "POST",
          body: JSON.stringify({ photoIds: [adminPhotoId] }),
        }
      );
      expect(completeRes.status).toBe(202);
    }, 30_000);

    describe("When the admin calls upload init, PUTs the file, and calls complete", () => {
      it("Then the photo row is created and the original is in S3", async () => {
        expect(adminPhotoId).toBeTruthy();
        expect(await s3ObjectExists(adminOriginalKey)).toBe(true);
      });
    });
  });

  // ─── Phase 2: Image processor ─────────────────────────────────────────────

  describe("Phase 2 — Given the photo is PENDING in the queue", () => {
    beforeAll(async () => {
      await waitUntilProcessed(adminCookie, event.id, 60_000);

      // Fetch the processed keys so later phases can verify S3 cleanup
      const eventRes = await authedFetch(`/api/events/${event.id}`, adminCookie);
      const body = (await eventRes.json()) as {
        photos: Array<{ id: string; thumbKey: string; displayKey: string; status: string }>;
      };
      const photo = body.photos.find((p) => p.id === adminPhotoId)!;
      adminThumbKey = photo.thumbKey;
      adminDisplayKey = photo.displayKey;
    }, 90_000);

    describe("When the image-processor worker completes the job", () => {
      it("Then the photo status is PROCESSED", async () => {
        const res = await authedFetch(`/api/events/${event.id}`, adminCookie);
        const body = (await res.json()) as { photos: Array<{ id: string; status: string }> };
        const photo = body.photos.find((p) => p.id === adminPhotoId);
        expect(photo?.status).toBe("PROCESSED");
      });

      it("Then the display-size S3 object exists", async () => {
        expect(adminDisplayKey).toBeTruthy();
        expect(await s3ObjectExists(adminDisplayKey)).toBe(true);
      });

      it("Then the thumbnail S3 object exists", async () => {
        expect(adminThumbKey).toBeTruthy();
        expect(await s3ObjectExists(adminThumbKey)).toBe(true);
      });

      it("Then the admin event detail returns presigned thumb and display URLs", async () => {
        const res = await authedFetch(`/api/events/${event.id}`, adminCookie);
        const body = (await res.json()) as {
          photos: Array<{ id: string; thumbUrl: string; displayUrl: string }>;
        };
        const photo = body.photos.find((p) => p.id === adminPhotoId)!;
        expect(photo.thumbUrl).toMatch(/^http/);
        expect(photo.displayUrl).toMatch(/^http/);
      });
    });
  });

  // ─── Phase 3: Guest gallery view ─────────────────────────────────────────

  describe("Phase 3 — Given a processed photo in a password-protected gallery", () => {
    describe("When a guest unlocks the gallery and requests GET /api/gallery/:slug", () => {
      it("Then the photo appears with thumb and display URLs", async () => {
        const galleryCookie = await unlockGallery(event.slug, "lifecycle-pass");
        const res = await fetch(`${API}/api/gallery/${event.slug}`, {
          headers: { Cookie: galleryCookie },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          photos: Array<{ thumbUrl: string; displayUrl: string }>;
        };
        expect(body.photos).toHaveLength(1);
        expect(body.photos[0].thumbUrl).toMatch(/^http/);
        expect(body.photos[0].displayUrl).toMatch(/^http/);
      });
    });
  });

  // ─── Phase 4: Guest upload ────────────────────────────────────────────────

  describe("Phase 4 — Given a guest with a valid gallery session uploads a photo", () => {
    beforeAll(async () => {
      const galleryCookie = await unlockGallery(event.slug, "lifecycle-pass");
      // Use a different PNG (different bytes → different hash) so deduplication
      // doesn't treat it as the admin photo (which used bluePng).
      const guestBytes = whitePng();
      const guestHash = sha256(guestBytes);

      const initRes = await fetch(`${API}/api/gallery/${event.slug}/upload/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: galleryCookie },
        body: JSON.stringify({
          photographerName: "Alice Guest",
          files: [
            {
              fileName: "guest-photo.png",
              ext: "png",
              contentType: "image/png",
              size: guestBytes.length,
              fileHash: guestHash,
            },
          ],
        }),
      });
      expect(initRes.status).toBe(200);
      const { photos } = (await initRes.json()) as { photos: Array<{ id: string }> };
      guestPhotoId = photos[0].id;
      guestOriginalKey = `${event.id}/${guestPhotoId}/original.png`;

      await putToS3(guestOriginalKey, guestBytes, "image/png");

      const completeRes = await fetch(`${API}/api/gallery/${event.slug}/upload/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: galleryCookie },
        body: JSON.stringify({ photoIds: [guestPhotoId] }),
      });
      expect(completeRes.status).toBe(202);

      await waitUntilProcessed(adminCookie, event.id, 60_000);

      // Capture guest photo keys for later S3 cleanup verification
      const eventRes = await authedFetch(`/api/events/${event.id}`, adminCookie);
      const body = (await eventRes.json()) as {
        photos: Array<{ id: string; thumbKey: string; displayKey: string }>;
      };
      const guestPhoto = body.photos.find((p) => p.id === guestPhotoId)!;
      guestThumbKey = guestPhoto.thumbKey;
      guestDisplayKey = guestPhoto.displayKey;
    }, 90_000);

    describe("When the guest upload is processed", () => {
      it("Then the gallery shows 2 photos total", async () => {
        const galleryCookie = await unlockGallery(event.slug, "lifecycle-pass");
        const res = await fetch(`${API}/api/gallery/${event.slug}`, {
          headers: { Cookie: galleryCookie },
        });
        const body = (await res.json()) as { photos: unknown[] };
        expect(body.photos).toHaveLength(2);
      });

      it("Then the guest photo is attributed to the photographer", async () => {
        const galleryCookie = await unlockGallery(event.slug, "lifecycle-pass");
        const res = await fetch(`${API}/api/gallery/${event.slug}`, {
          headers: { Cookie: galleryCookie },
        });
        const body = (await res.json()) as {
          photos: Array<{ photographerName: string | null }>;
        };
        const guestPhoto = body.photos.find((p) => p.photographerName === "Alice Guest");
        expect(guestPhoto).toBeDefined();
      });

      it("Then the guest photo's S3 objects exist", async () => {
        expect(await s3ObjectExists(guestOriginalKey)).toBe(true);
        expect(await s3ObjectExists(guestThumbKey)).toBe(true);
        expect(await s3ObjectExists(guestDisplayKey)).toBe(true);
      });
    });
  });

  // ─── Phase 5: Delete a single photo ──────────────────────────────────────

  describe("Phase 5 — Given the admin deletes the admin-uploaded photo", () => {
    beforeAll(async () => {
      const res = await authedFetch(
        `/api/events/${event.id}/photos/${adminPhotoId}`,
        adminCookie,
        { method: "DELETE" }
      );
      expect(res.status).toBe(200);
    }, 15_000);

    describe("When DELETE /api/events/:id/photos/:photoId is called", () => {
      it("Then the photo no longer appears in the admin event detail", async () => {
        const res = await authedFetch(`/api/events/${event.id}`, adminCookie);
        const body = (await res.json()) as { photos: Array<{ id: string }> };
        expect(body.photos.find((p) => p.id === adminPhotoId)).toBeUndefined();
      });

      it("Then the photo is no longer visible in the guest gallery", async () => {
        const galleryCookie = await unlockGallery(event.slug, "lifecycle-pass");
        const res = await fetch(`${API}/api/gallery/${event.slug}`, {
          headers: { Cookie: galleryCookie },
        });
        const body = (await res.json()) as { photos: Array<{ id: string }> };
        expect(body.photos.find((p) => p.id === adminPhotoId)).toBeUndefined();
        // Guest photo is still there
        expect(body.photos).toHaveLength(1);
      });

      it("Then the deleted photo's original S3 object is removed", async () => {
        expect(await s3ObjectExists(adminOriginalKey)).toBe(false);
      });

      it("Then the deleted photo's display S3 object is removed", async () => {
        expect(await s3ObjectExists(adminDisplayKey)).toBe(false);
      });

      it("Then the deleted photo's thumbnail S3 object is removed", async () => {
        expect(await s3ObjectExists(adminThumbKey)).toBe(false);
      });
    });
  });

  // ─── Phase 6: Delete the entire event ────────────────────────────────────

  describe("Phase 6 — Given the admin deletes the entire event", () => {
    beforeAll(async () => {
      const res = await authedFetch(`/api/events/${event.id}`, adminCookie, { method: "DELETE" });
      expect(res.status).toBe(200);
    }, 15_000);

    describe("When DELETE /api/events/:id is called", () => {
      it("Then GET /api/events/:id returns 404", async () => {
        const res = await authedFetch(`/api/events/${event.id}`, adminCookie);
        expect(res.status).toBe(404);
      });

      it("Then the remaining guest photo's original S3 object is removed", async () => {
        expect(await s3ObjectExists(guestOriginalKey)).toBe(false);
      });

      it("Then the remaining guest photo's display S3 object is removed", async () => {
        expect(await s3ObjectExists(guestDisplayKey)).toBe(false);
      });

      it("Then the remaining guest photo's thumbnail S3 object is removed", async () => {
        expect(await s3ObjectExists(guestThumbKey)).toBe(false);
      });
    });
  });
});
