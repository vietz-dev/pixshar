-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_download_job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DEBOUNCING',
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "processedPhotos" INTEGER NOT NULL DEFAULT 0,
    "zipKey" TEXT,
    "zipSizeBytes" INTEGER,
    "debounceUntil" DATETIME,
    "failureReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "download_job_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "event" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_download_job" ("createdAt", "debounceUntil", "eventId", "failureReason", "id", "photoCount", "status", "updatedAt", "zipKey", "zipSizeBytes") SELECT "createdAt", "debounceUntil", "eventId", "failureReason", "id", "photoCount", "status", "updatedAt", "zipKey", "zipSizeBytes" FROM "download_job";
DROP TABLE "download_job";
ALTER TABLE "new_download_job" RENAME TO "download_job";
CREATE UNIQUE INDEX "download_job_eventId_key" ON "download_job"("eventId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
