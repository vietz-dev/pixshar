// Barrel — re-exports the public surface of the downloadJob module, split
// across apps/api/src/services/downloadJob/* along its numbered sections so
// the follow-up tickets (reaper, lazy-trigger, deletion, admin actions,
// metrics, idle-expiry) can each own a file instead of colliding in one
// 1000+ line module. No behavior lives here — see downloadJob/*.ts.
//
// Module map:
//   status   — shared core (quality constants, statusMessage, membershipSig,
//              pushDownloadStatus/notifyDownloadStatus). Leaf: imports none
//              of the other downloadJob modules.
//   triggers — §1/§1a/§1b: triggerDebounce(AllVariants), requestBuild (the only
//              path that creates an archive), triggerReconcile(AllVariants).
//   poller   — §2/§2b: startDebouncePoller, reapStaleBuilding, startZipReaper.
//   admin    — §3: buildNow, rebuildAll, cancelJob, buildAdminDownloadStatus
//              (the shared admin status shape behind GET .../status and its
//              SSE stream — EXPIRED + remaining lifetime, PIXSHAR-8).
//   payload  — DownloadPart/DownloadPayload/BothVariantsPayload,
//              buildDownloadPayload, buildBothVariantsPayload,
//              registerPartDownload, getDownloadJobStatus.
//   builder  — §4/§5: runBuildZip and the build/streaming pipeline.
//   expiry   — the pure idle-expiry decision (isExpired). No DB/S3/env imports,
//              so it is unit-testable without a running stack.
//   reaper   — the effect side of expiry: expireArchive (S3 reclaim → EXPIRED,
//              membership preserved), the admin release path and the periodic
//              sweep that drives them.
//   deletion — expirePartsForDeletedPhotos: a deleted photo's parts lose their
//              S3 object immediately (correctness, not cost), no build queued.

export {
  type Quality,
  DEFAULT_QUALITY,
  ALL_QUALITIES,
  statusMessage,
  pushDownloadStatus,
  notifyDownloadStatus,
} from "./downloadJob/status.js";

export {
  type BuildSource,
  requestBuild,
  triggerDebounce,
  triggerDebounceAllVariants,
  triggerReconcile,
  triggerReconcileAllVariants,
} from "./downloadJob/triggers.js";

export {
  startDebouncePoller,
  reapStaleBuilding,
  startZipReaper,
} from "./downloadJob/poller.js";

export {
  buildNow,
  rebuildAll,
  cancelJob,
  type AdminDownloadStatus,
  buildAdminDownloadStatus,
} from "./downloadJob/admin.js";

export {
  type DownloadPart,
  type DownloadPayload,
  type BothVariantsPayload,
  type PartDownloadTicket,
  ARCHIVE_PART_PRESIGN_SECONDS,
  buildDownloadPayload,
  GUEST_DEFAULT_QUALITY,
  buildBothVariantsPayload,
  registerPartDownload,
  getDownloadJobStatus,
} from "./downloadJob/payload.js";

export { runBuildZip } from "./downloadJob/builder.js";

export { type ExpiryCandidate, isExpired } from "./downloadJob/expiry.js";

export {
  type ExpirableJob,
  expireArchive,
  releaseArchive,
  sweepExpiredArchives,
  startExpiryReaper,
} from "./downloadJob/reaper.js";

export { expirePartsForDeletedPhotos } from "./downloadJob/deletion.js";
