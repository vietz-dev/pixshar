-- AlterTable
ALTER TABLE "photo" ADD COLUMN "fileHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "photo_eventId_fileHash_key" ON "photo"("eventId", "fileHash");
