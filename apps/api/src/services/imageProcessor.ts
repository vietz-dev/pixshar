import { Effect, Schedule, Console } from "effect";
import { s3, getS3Object, deleteS3Object } from "../lib/s3.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { sha256Hex } from "../lib/hash.js";
import { isValidImageBytes, MAX_FILE_SIZE } from "../lib/validate.js";
import { triggerDebounce } from "./downloadJob.js";
import { emitPhotoStatus } from "../lib/eventBus.js";

async function pushPhotoStatus(eventId: string): Promise<void> {
  const counts = await prisma.photo.groupBy({
    by: ["status"],
    where: { eventId },
    _count: { status: true },
  });
  const pending = counts.find((r: typeof counts[0]) => r.status === "PENDING")?._count.status ?? 0;
  const processed = counts.find((r: typeof counts[0]) => r.status === "PROCESSED")?._count.status ?? 0;
  const failed = counts.find((r: typeof counts[0]) => r.status === "FAILED")?._count.status ?? 0;
  emitPhotoStatus(eventId, { pending, processed, failed, total: pending + processed + failed });
}

export interface ProcessImageInput {
  photoId: string;
  eventId: string;
  ext: string;
  // Key of the original the client already uploaded directly to S3.
  originalKey: string;
  // Client-supplied hash stored at init; reconciled here against the real bytes.
  fileHash: string;
}

// Thrown when the uploaded original isn't a valid/sane image. Not retried —
// retrying won't change the bytes — so it bypasses the retry schedule.
class InvalidOriginalError extends Error {
  readonly _tag = "InvalidOriginalError";
}

export interface ProcessImageOutput {
  originalKey: string;
  displayKey: string;
  thumbKey: string;
}

// Concurrency semaphore: limit to 8 concurrent image processing jobs
const MAX_CONCURRENT = 8;
let activeJobs = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  return new Promise((resolve) => {
    if (activeJobs < MAX_CONCURRENT) {
      activeJobs++;
      resolve();
    } else {
      queue.push(() => {
        activeJobs++;
        resolve();
      });
    }
  });
}

function release(): void {
  activeJobs = Math.max(0, activeJobs - 1);
  const next = queue.shift();
  if (next) next();
}

const uploadToS3 = (key: string, buffer: Buffer, contentType: string) =>
  Effect.tryPromise({
    try: () =>
      s3.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        })
      ),
    catch: (e) => new Error(`S3 upload failed: ${e}`),
  });

const resizeImage = (
  buffer: Buffer,
  width: number,
  height: number,
  quality: number,
  format: "jpeg" | "webp" = "jpeg"
) =>
  Effect.tryPromise({
    try: async () => {
      const img = new Bun.Image(buffer);
      await img.metadata();
      const resized = img.resize(width, height, { fit: "inside" });
      const out = await resized[format]({ quality }).bytes();
      return Buffer.from(out);
    },
    catch: (e) => new Error(`Resize failed: ${e}`),
  });

const processImageEffect = (input: ProcessImageInput) =>
  Effect.gen(function* () {
    const { photoId, eventId, ext, originalKey, fileHash } = input;
    const base = `${eventId}/${photoId}`;
    const displayKey = `${base}/display.${ext}`;
    const thumbKey = `${base}/thumb.${ext}`;

    yield* Console.log(`Processing photo ${photoId}`);

    // The client uploaded the original directly to S3 — fetch it back to process.
    const buffer = yield* Effect.tryPromise({
      try: () => getS3Object(originalKey),
      catch: (e) => new Error(`Failed to fetch original ${originalKey}: ${e}`),
    });

    // Validation moved here (the API never saw these bytes at upload time):
    // reject anything that isn't a sane image. Not retryable.
    if (buffer.length > MAX_FILE_SIZE || !isValidImageBytes(buffer)) {
      yield* Effect.fail(new InvalidOriginalError(`Original ${originalKey} is not a valid image`));
    }

    // Reconcile the stored (client-claimed) hash against the real bytes.
    const actualHash = sha256Hex(buffer);
    if (actualHash !== fileHash) {
      yield* Console.error(`Hash mismatch for ${photoId}: claimed ${fileHash}, actual ${actualHash}`);
      yield* Effect.tryPromise({
        try: () => prisma.photo.update({ where: { id: photoId }, data: { fileHash: actualHash } }),
        catch: (e) => new Error(`DB hash reconcile failed: ${e}`),
      });
    }

    const [displayBuf, thumbBuf] = yield* Effect.all([
      resizeImage(buffer, 1920, 1920, 85, ext === "png" ? "jpeg" : "jpeg"),
      resizeImage(buffer, 400, 400, 80, "jpeg"),
    ]);

    yield* Effect.all([
      uploadToS3(displayKey, displayBuf, "image/jpeg"),
      uploadToS3(thumbKey, thumbBuf, "image/jpeg"),
    ]);

    yield* Effect.tryPromise({
      try: () =>
        prisma.photo.update({
          where: { id: photoId },
          data: {
            displayKey,
            thumbKey,
            status: "PROCESSED",
          },
        }),
      catch: (e) => new Error(`DB update failed: ${e}`),
    });

    yield* Console.log(`Photo ${photoId} processed`);
    yield* Effect.promise(() => pushPhotoStatus(eventId).catch(() => {}));

    // Trigger download archive debounce (non-blocking, failures ignored)
    yield* Effect.promise(() => triggerDebounce(eventId).catch(() => {}));

    return { originalKey, displayKey, thumbKey };
  }).pipe(
    // Don't waste retries on bytes that will never become a valid image.
    Effect.retry({
      times: 3,
      schedule: Schedule.exponential("1 second"),
      while: (e) => !(e instanceof InvalidOriginalError),
    }),
    Effect.catchAll((e) =>
      Effect.gen(function* () {
        yield* Console.error(`Failed to process photo ${input.photoId}: ${e}`);
        // A bad/invalid original shouldn't linger in S3 (and frees the dedup
        // hash via the FAILED-row recycling on retry).
        if (e instanceof InvalidOriginalError) {
          yield* Effect.promise(() => deleteS3Object(input.originalKey).catch(() => {}));
        }
        yield* Effect.tryPromise({
          try: () =>
            prisma.photo.update({
              where: { id: input.photoId },
              data: { status: "FAILED" },
            }),
          catch: () => new Error("DB update failed"),
        });
        yield* Effect.promise(() => pushPhotoStatus(input.eventId).catch(() => {}));
        return { originalKey: "", displayKey: "", thumbKey: "" };
      })
    )
  );

export const processImage = (input: ProcessImageInput) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => acquire());
    const result = yield* processImageEffect(input).pipe(
      Effect.ensuring(Effect.sync(release))
    );
    return result;
  }).pipe(
    Effect.catchAll(() =>
      Effect.succeed({ originalKey: "", displayKey: "", thumbKey: "" })
    )
  );
