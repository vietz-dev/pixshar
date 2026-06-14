import { Effect, Schedule, Console } from "effect";
import { s3 } from "../lib/s3.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";

export interface ProcessImageInput {
  photoId: string;
  buffer: Buffer;
  eventId: string;
  ext: string;
}

export interface ProcessImageOutput {
  originalKey: string;
  displayKey: string;
  thumbKey: string;
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

export const processImage = (input: ProcessImageInput) =>
  Effect.gen(function* () {
    const { photoId, buffer, eventId, ext } = input;
    const base = `${eventId}/${photoId}`;
    const originalKey = `${base}/original.${ext}`;
    const displayKey = `${base}/display.${ext}`;
    const thumbKey = `${base}/thumb.${ext}`;

    const contentType = ext === "png" ? "image/png" : "image/jpeg";

    yield* Console.log(`Processing photo ${photoId}`);

    yield* uploadToS3(originalKey, buffer, contentType);

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
            originalKey,
            displayKey,
            thumbKey,
            status: "PROCESSED",
          },
        }),
      catch: (e) => new Error(`DB update failed: ${e}`),
    });

    yield* Console.log(`Photo ${photoId} processed`);

    return { originalKey, displayKey, thumbKey };
  }).pipe(
    Effect.retry({
      times: 3,
      schedule: Schedule.exponential("1 second"),
    }),
    Effect.catchAll((e) =>
      Effect.gen(function* () {
        yield* Console.error(`Failed to process photo ${input.photoId}: ${e}`);
        yield* Effect.tryPromise({
          try: () =>
            prisma.photo.update({
              where: { id: input.photoId },
              data: { status: "FAILED" },
            }),
          catch: () => new Error("DB update failed"),
        });
        return { originalKey: "", displayKey: "", thumbKey: "" };
      })
    )
  );
