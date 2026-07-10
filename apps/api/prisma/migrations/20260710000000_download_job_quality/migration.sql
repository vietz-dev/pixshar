-- Download-Varianten: add the ArchiveQuality dimension to download jobs.
--
-- A job now builds one of two variants — DISPLAY (Kompakt) or ORIGINAL. The
-- variant lives on the job (not the part) because the job is the unit a worker
-- atomically claims, so two variants become two independently claimable jobs.
--
-- Migration is purely additive: the existing builder zipped originals, so every
-- pre-existing job IS an ORIGINAL variant → the DEFAULT 'ORIGINAL' covers all
-- current rows with no data rewrite. Uniqueness moves from (eventId) to
-- (eventId, quality) so a second (DISPLAY) job per event can be created later.

-- CreateEnum
CREATE TYPE "ArchiveQuality" AS ENUM ('DISPLAY', 'ORIGINAL');

-- AlterTable: existing rows default to ORIGINAL (they zipped originals).
ALTER TABLE "download_job"
ADD COLUMN "quality" "ArchiveQuality" NOT NULL DEFAULT 'ORIGINAL';

-- Uniqueness: one job per (event, variant) instead of one job per event.
DROP INDEX "download_job_eventId_key";
CREATE UNIQUE INDEX "download_job_eventId_quality_key" ON "download_job"("eventId", "quality");
