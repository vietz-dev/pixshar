import { oc } from "@orpc/contract";
import { z } from "zod";

/** How many PROCESSED photos still lack a blur placeholder. */
export const backfillStatus = z.object({ total: z.number(), missing: z.number() });
export type BackfillStatus = z.infer<typeof backfillStatus>;

/**
 * One frame of the backfill progress stream. The run itself stays a plain
 * POST + `ReadableStream` route (`POST /api/admin/backfill/start`) — an
 * EventSource cannot POST — so only its payload type lives in the contract.
 */
export const backfillProgress = z.object({
  total: z.number(),
  processed: z.number(),
  done: z.boolean().optional(),
});
export type BackfillProgress = z.infer<typeof backfillProgress>;

export const admin = {
  backfillStatus: oc.input(z.object({}).optional()).output(backfillStatus),
};
