-- AlterTable
ALTER TABLE "download_job"
ADD COLUMN     "partCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "queuedAt" TIMESTAMP(3),
ADD COLUMN     "totalSizeBytes" BIGINT;

-- CreateTable
CREATE TABLE "download_archive_part" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "download_archive_part_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "download_archive_part_jobId_partIndex_key" ON "download_archive_part"("jobId", "partIndex");

-- AddForeignKey
ALTER TABLE "download_archive_part" ADD CONSTRAINT "download_archive_part_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "download_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve existing single-zip archives as one-part archives
INSERT INTO "download_archive_part" ("id", "jobId", "partIndex", "key", "sizeBytes")
SELECT "id" || '-part-1', "id", 1, "zipKey", COALESCE("zipSizeBytes", 0)::BIGINT
FROM "download_job"
WHERE "zipKey" IS NOT NULL;

UPDATE "download_job"
SET "totalSizeBytes" = "zipSizeBytes"::BIGINT, "partCount" = 1
WHERE "zipKey" IS NOT NULL;

-- Drop legacy single-zip columns
ALTER TABLE "download_job"
DROP COLUMN "zipKey",
DROP COLUMN "zipSizeBytes";
