-- Incremental, immutable archive parts.
--
-- Parts become long-lived and immutable: a build only appends new photos as new
-- parts and rebuilds a part in place when a photo inside it is deleted. This adds
-- per-part status/versioning and a durable membership table.

-- AlterTable: new per-part columns
ALTER TABLE "download_archive_part"
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'READY',
ADD COLUMN     "membershipSig" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "photoCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "download_archive_part" ALTER COLUMN "sizeBytes" SET DEFAULT 0;

-- CreateTable: durable part membership
CREATE TABLE "download_archive_part_entry" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,

    CONSTRAINT "download_archive_part_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "download_archive_part_entry_partId_photoId_key" ON "download_archive_part_entry"("partId", "photoId");
CREATE INDEX "download_archive_part_entry_photoId_idx" ON "download_archive_part_entry"("photoId");

-- AddForeignKey (only to the part — NOT to photo, by design)
ALTER TABLE "download_archive_part_entry" ADD CONSTRAINT "download_archive_part_entry_partId_fkey" FOREIGN KEY ("partId") REFERENCES "download_archive_part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One-time backfill: existing parts have no recorded membership (we cannot know
-- which photos are inside each pre-existing ZIP). Drop them and requeue any READY
-- job so the next build re-establishes parts + membership cleanly under the new
-- model. Fresh S3 objects are written under versioned keys; the old, unversioned
-- objects are orphaned and cleaned up by the archive-prefix sweep on rebuild.
DELETE FROM "download_archive_part";

UPDATE "download_job"
SET "status" = 'QUEUED',
    "queuedAt" = CURRENT_TIMESTAMP,
    "partCount" = 0,
    "totalSizeBytes" = NULL,
    "processedPhotos" = 0
WHERE "status" = 'READY';
