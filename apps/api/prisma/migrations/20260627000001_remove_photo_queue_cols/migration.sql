-- Migration: remove custom durable-queue columns from "photo".
-- These were used by resizeWorker.ts (FOR UPDATE SKIP LOCKED pattern).
-- pg-boss now owns job scheduling; Photo retains status/attempts/lastError
-- for admin UI display only.

-- Reset any rows stuck in PROCESSING at migration time (orphaned by the old
-- worker). They become PENDING so pg-boss picks them up on next upload retry.
UPDATE "photo"
SET status = 'PENDING'
WHERE status = 'PROCESSING';

-- Drop indexes first (explicit to make intent clear in migration history).
DROP INDEX IF EXISTS "photo_status_nextAttemptAt_idx";
DROP INDEX IF EXISTS "photo_status_claimedAt_idx";

-- Drop the queue-management columns.
ALTER TABLE "photo"
  DROP COLUMN IF EXISTS "claimedAt",
  DROP COLUMN IF EXISTS "claimedBy",
  DROP COLUMN IF EXISTS "nextAttemptAt";
