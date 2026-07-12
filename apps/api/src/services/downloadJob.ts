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
//   triggers — §1/§1b: ensureJob, triggerDebounce(AllVariants),
//              triggerReconcile(AllVariants).
//   poller   — §2/§2b: startDebouncePoller, reapStaleBuilding, startZipReaper.
//   admin    — §3: buildNow, rebuildAll, cancelJob.
//   payload  — DownloadPart/DownloadPayload/BothVariantsPayload,
//              buildDownloadPayload, buildBothVariantsPayload,
//              registerPartDownload, getDownloadJobStatus.
//   builder  — §4/§5: runBuildZip and the build/streaming pipeline.
//   expiry   — reserved, empty; home for the idle-expiry ticket.

export {
  type Quality,
  DEFAULT_QUALITY,
  ALL_QUALITIES,
  statusMessage,
  pushDownloadStatus,
  notifyDownloadStatus,
} from "./downloadJob/status.js";

export {
  ensureJob,
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

export { buildNow, rebuildAll, cancelJob } from "./downloadJob/admin.js";

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
