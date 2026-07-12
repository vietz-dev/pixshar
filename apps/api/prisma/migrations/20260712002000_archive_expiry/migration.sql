-- AlterEnum
ALTER TYPE "DownloadJobStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "download_job" ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "expiryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastDownloadedAt" TIMESTAMP(3),
ADD COLUMN     "readyAt" TIMESTAMP(3),
ADD COLUMN     "rebuildCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill the idle clock. Every archive that already exists at deploy time gets
-- a full TTL grace period (lastDownloadedAt = now()) instead of being reaped on
-- the first sweep — we have no download history for it, and treating "unknown"
-- as "idle forever" would delete every existing archive at once.
UPDATE "download_job"
SET "lastDownloadedAt" = NOW(),
    "readyAt" = COALESCE("readyAt", "updatedAt")
WHERE "status" = 'READY';
