// Photo deletion — the correctness half of archive expiry (PIXSHAR-6).
//
// A deleted photo must stop being downloadable at once. Until now a deletion
// only marked the containing parts STALE while the old S3 object KEPT SERVING
// (with the deleted photo inside it) until a reconcile replaced it ~a minute
// later. Under the lazy model no build is queued on deletion at all, so that
// window would stay open indefinitely — a deleted photo would remain
// downloadable for days, until some guest happened to request a rebuild.
//
// So: the parts containing a deleted photo lose their S3 object right here, in
// the delete request, and go EXPIRED; their membership is pruned of the photo.
// No build is queued — the next explicit request rebuilds them from the pruned
// membership (same partIndex, new membershipSig, since the contents genuinely
// changed). Parts that did not contain the photo are untouched and stay
// downloadable: this is the one path that produces a *partially available*
// variant.
import { Effect, Schedule } from "effect";
import { prisma } from "../../lib/prisma.js";
import { deleteS3Objects } from "../../lib/s3.js";
import { ALL_QUALITIES, notifyDownloadStatus } from "./status.js";
import { partHasObject } from "./payload.js";

/**
 * Reclaim the S3 objects of every archive part that contains one of the deleted
 * photos, across BOTH variants (the `job: { eventId }` filter spans DISPLAY and
 * ORIGINAL), and prune those photos from the surviving membership. A part whose
 * last member was deleted is dropped entirely — partIndex values are NOT
 * renumbered, so gaps stay and every other part keeps its identity (and with it
 * a guest's per-part "downloaded" tick).
 *
 * Returns the number of parts touched.
 *
 * Order — rows first, then objects, the mirror image of the reaper's rule:
 * there the job's CAS claim is what stops a part being offered, here it is the
 * part row itself (EXPIRED ⇒ no object). Flipping the rows first means a part is
 * never advertised while its bytes are being reclaimed. A crash in between
 * leaves an EXPIRED part carrying a dead key whose object still exists — nothing
 * serves it (the payload and the redirect endpoint both gate on the row), and
 * the rebuild deletes the old key when it writes generation + 1.
 */
export async function expirePartsForDeletedPhotos(
  eventId: string,
  photoIds: string[]
): Promise<number> {
  if (photoIds.length === 0) return 0;

  const affected = await prisma.downloadArchivePart.findMany({
    where: {
      job: { eventId },
      entries: { some: { photoId: { in: photoIds } } },
    },
    select: {
      id: true,
      key: true,
      status: true,
      partIndex: true,
      entries: { select: { photoId: true } },
    },
  });
  if (affected.length === 0) return 0;

  const deleted = new Set(photoIds);
  const remainingOf = (part: (typeof affected)[number]) =>
    part.entries.filter((e) => !deleted.has(e.photoId)).length;
  const emptied = affected.filter((p) => remainingOf(p) === 0);
  const survivors = affected.filter((p) => remainingOf(p) > 0);

  await prisma.$transaction(async (tx) => {
    for (const part of survivors) {
      await tx.downloadArchivePartEntry.deleteMany({
        where: { partId: part.id, photoId: { in: photoIds } },
      });
      await tx.downloadArchivePart.update({
        where: { id: part.id },
        // The row and its (pruned) membership are the durable thing; only the
        // bytes are gone.
        data: { status: "EXPIRED", photoCount: remainingOf(part) },
      });
    }
    if (emptied.length > 0) {
      // Entries cascade with the part row.
      await tx.downloadArchivePart.deleteMany({
        where: { id: { in: emptied.map((p) => p.id) } },
      });
    }
  });

  const keys = affected.filter(partHasObject).map((p) => p.key);
  if (keys.length > 0) {
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => deleteS3Objects(keys),
        catch: (e) => new Error(`Archive part delete failed: ${e}`),
      }).pipe(
        Effect.retry({ times: 3, schedule: Schedule.exponential("500 millis") }),
        Effect.catchAll((e) =>
          // The rows are already EXPIRED, so nothing is served from these
          // objects; they are swept when the parts are rebuilt.
          Effect.sync(() =>
            console.error(`[ArchiveDeletion] event=${eventId} object delete failed: ${e}`)
          )
        )
      )
    );
  }

  console.log(
    `[ArchiveDeletion] event=${eventId} photos=${photoIds.length} expired=${survivors.length} removed=${emptied.length} objects=${keys.length}`
  );

  // No build is queued: the variant is rebuilt on the next explicit request.
  // The push only tells the open pages that those parts are gone.
  for (const quality of ALL_QUALITIES) {
    await notifyDownloadStatus(eventId, quality).catch(() => {});
  }

  return affected.length;
}

/**
 * Close the mid-build window from the other side (PIXSHAR-6).
 *
 * The builder snapshots the event's photos (loadPhotos) and only commits the
 * part rows and their membership minutes later. `DownloadArchivePartEntry.photoId`
 * is a bare String with no FK to `Photo`, so nothing rejects an entry for a photo
 * that was deleted in between — and expirePartsForDeletedPhotos, running inside
 * that delete request, found no entries to expire because they did not exist
 * yet. The part then commits READY with the deleted photo's bytes inside it, and
 * under the lazy model no later build ever revisits it: the photo stays
 * downloadable indefinitely, which is precisely what "not retrievable from any
 * archive object from the moment the delete returns" forbids.
 *
 * So every build ends by checking its own output: any part still referencing a
 * photo that no longer exists is put through the ORDINARY deletion path above —
 * object reclaimed, membership pruned, part left EXPIRED for the next request to
 * rebuild. One code path owns archive-part reclamation, not two.
 *
 * Costs two indexed queries per build when (as usual) nothing was deleted.
 */
export async function expirePartsForMissingPhotos(eventId: string): Promise<number> {
  const referenced = await prisma.downloadArchivePartEntry.findMany({
    where: { part: { job: { eventId } } },
    select: { photoId: true },
    distinct: ["photoId"],
  });
  if (referenced.length === 0) return 0;

  const photoIds = referenced.map((e) => e.photoId);
  const alive = await prisma.photo.findMany({
    where: { id: { in: photoIds } },
    select: { id: true },
  });
  const aliveIds = new Set(alive.map((p) => p.id));
  const missing = photoIds.filter((id) => !aliveIds.has(id));
  if (missing.length === 0) return 0;

  console.warn(
    `[ArchiveDeletion] event=${eventId} ${missing.length} membership entr(ies) outlived their photo — expiring their parts`
  );
  return expirePartsForDeletedPhotos(eventId, missing);
}
