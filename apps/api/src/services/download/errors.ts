import { Data } from "effect";

/**
 * The single failure type of `DownloadService`. Every underlying failure
 * (Prisma, S3 presigning, pg-boss) is normalised to this so handlers see one
 * tagged error instead of unknown rejections.
 */
export class DownloadServiceError extends Data.TaggedError("DownloadServiceError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  get message(): string {
    return `Download service failed during ${this.operation}: ${String(this.cause)}`;
  }
}
