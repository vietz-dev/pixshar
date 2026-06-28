import type PgBoss from "pg-boss";
import { Effect } from "effect";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { deleteS3Object } from "../lib/s3.js";
import { PG_NOTIFY_CHANNEL } from "../lib/pgNotifyListener.js";
import {
  processImageEffect,
  InvalidOriginalError,
  type ProcessImageInput,
} from "../services/imageProcessor.js";
import {
  imageProcessingTotal,
  imageProcessingDuration,
} from "../lib/metrics.js";

export interface PhotoResizeData {
  photoId: string;
}

export async function photoResizeHandler(
  job: PgBoss.Job<PhotoResizeData>
): Promise<void> {
  const { photoId } = job.data;

  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo) {
    // Photo deleted while queued — discard silently.
    return;
  }
  if (photo.status === "PROCESSED") {
    // Already handled (e.g., duplicate job).
    return;
  }

  // Derive attempt number from DB so we don't need pg-boss metadata fields.
  const attempt = photo.attempts + 1;

  await prisma.photo.updateMany({
    where: { id: photoId, status: { notIn: ["PROCESSED"] } },
    data: { status: "PROCESSING", attempts: attempt },
  });

  const ext = photo.originalKey.split(".").pop() ?? "jpg";
  const input: ProcessImageInput = {
    photoId: photo.id,
    eventId: photo.eventId,
    ext,
    originalKey: photo.originalKey,
    fileHash: photo.fileHash!,
  };

  const endTimer = imageProcessingDuration.startTimer();

  try {
    await Effect.runPromise(processImageEffect(input));
    imageProcessingTotal.inc({ result: "success" });
    endTimer({ result: "success" });

    // Notify API process(es) via pg_notify so SSE streams fire.
    // The listener re-fetches photo keys and presigns URLs itself.
    await prisma.$executeRawUnsafe(
      `SELECT pg_notify($1, $2)`,
      PG_NOTIFY_CHANNEL,
      JSON.stringify({ type: "photo.processed", eventId: photo.eventId, photoId })
    );
  } catch (e) {
    const isInvalid = e instanceof InvalidOriginalError;
    const isExhausted = attempt >= env.PROCESS_MAX_ATTEMPTS;
    const label = isInvalid ? "invalid" : "failure";

    imageProcessingTotal.inc({ result: label });
    endTimer({ result: label });

    if (isInvalid) {
      await deleteS3Object(photo.originalKey).catch(() => {});
    }

    const isTerminal = isInvalid || isExhausted;

    await prisma.photo.updateMany({
      where: { id: photoId },
      data: {
        status: isTerminal ? "FAILED" : "PENDING",
        lastError: String(e),
        attempts: attempt,
      },
    });

    await prisma.$executeRawUnsafe(
      `SELECT pg_notify($1, $2)`,
      PG_NOTIFY_CHANNEL,
      JSON.stringify({ type: "photo.status", eventId: photo.eventId })
    );

    if (!isTerminal) {
      // Rethrow so pg-boss marks this attempt failed and schedules a retry.
      throw e;
    }
    // Terminal: return without throwing — pg-boss considers the job complete (no retry).
  }
}
