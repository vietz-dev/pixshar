// Reserved home for idle-expiry logic (PIXSHAR-1, ticket 3: "Idle-Expiry").
// An archive that hasn't been downloaded in DOWNLOAD_ARCHIVE_TTL_DAYS is
// disposable — its ZIP bytes get deleted from S3 while the DownloadJob +
// DownloadArchivePart rows (the membership) stay, so a later request can
// rebuild the same parts with the same partIndex + membershipSig.
//
// Intentionally empty until that ticket lands — created ahead of time so two
// parallel agents don't both invent this module.
