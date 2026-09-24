import type { BothVariantsPayload, DownloadStatus, Quality } from "@pixshar/contracts";
import { Context, Effect, Layer } from "effect";
import { archiveDownloadsTotal } from "../../lib/metrics.js";
import { prisma } from "../../lib/prisma.js";
import {
  buildBothVariantsPayload,
  buildNow,
  cancelJob,
  rebuildAll,
  statusMessage,
} from "../downloadJob.js";
import { DownloadServiceError } from "./errors.js";

export interface DownloadServiceApi {
  /** Admin build status for one variant; "NONE" when no job row exists yet. */
  readonly status: (
    eventId: string,
    quality: Quality,
  ) => Effect.Effect<DownloadStatus, DownloadServiceError>;
  /** Skip the debounce wait and queue the pending reconcile now. */
  readonly buildNow: (
    eventId: string,
    quality: Quality,
  ) => Effect.Effect<void, DownloadServiceError>;
  /** Rebuild every part's bytes, preserving each part's membership. */
  readonly rebuildAll: (
    eventId: string,
    quality: Quality,
  ) => Effect.Effect<void, DownloadServiceError>;
  /** Stop adding parts; already-committed parts stay downloadable. */
  readonly cancel: (eventId: string, quality: Quality) => Effect.Effect<void, DownloadServiceError>;
  /** Guest payload: both variants with presigned part URLs. */
  readonly guestPayload: (
    eventId: string,
    slug: string,
  ) => Effect.Effect<BothVariantsPayload, DownloadServiceError>;
}

export class DownloadService extends Context.Tag("DownloadService")<
  DownloadService,
  DownloadServiceApi
>() {}

/** Promise → Effect with every failure normalised to one tagged error. */
const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DownloadServiceError({ operation, cause }),
  });

const api: DownloadServiceApi = {
  status: (eventId, quality) =>
    attempt("status", async () => {
      const [job, totalPhotos] = await Promise.all([
        prisma.downloadJob.findUnique({ where: { eventId_quality: { eventId, quality } } }),
        prisma.photo.count({ where: { eventId, status: "PROCESSED" } }),
      ]);

      if (!job) {
        return {
          quality,
          status: "NONE",
          message: statusMessage("NONE"),
          photoCount: 0,
          processedPhotos: 0,
          uploadProgress: 0,
          totalPhotos,
          totalSizeBytes: null,
          partCount: 0,
          debounceUntil: null,
          failureReason: null,
          updatedAt: new Date().toISOString(),
        };
      }

      return {
        quality: job.quality,
        status: job.status,
        message: statusMessage(job.status),
        photoCount: job.photoCount,
        processedPhotos: job.processedPhotos,
        uploadProgress: job.uploadProgress,
        totalPhotos,
        totalSizeBytes: job.totalSizeBytes === null ? null : Number(job.totalSizeBytes),
        partCount: job.partCount,
        debounceUntil: job.debounceUntil?.toISOString() ?? null,
        failureReason: job.failureReason,
        updatedAt: job.updatedAt.toISOString(),
      };
    }),

  buildNow: (eventId, quality) => attempt("buildNow", () => buildNow(eventId, quality)),
  rebuildAll: (eventId, quality) => attempt("rebuildAll", () => rebuildAll(eventId, quality)),
  cancel: (eventId, quality) => attempt("cancel", () => cancelJob(eventId, quality)),

  guestPayload: (eventId, slug) =>
    attempt("guestPayload", async () => {
      const payload = await buildBothVariantsPayload(eventId, slug);
      if (payload.status === "READY") archiveDownloadsTotal.inc();
      return payload;
    }),
};

export const DownloadServiceLive = Layer.succeed(DownloadService, api);
