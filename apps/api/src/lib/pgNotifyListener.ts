import pg from "pg";
import { env } from "./env.js";
import { emitPhotoProcessed } from "./eventBus.js";
import { pushPhotoStatus } from "../services/imageProcessor.js";
import { pushDownloadStatus } from "../services/downloadJob.js";
import { prisma } from "./prisma.js";
import { getPresignedUrl } from "./s3.js";

export const PG_NOTIFY_CHANNEL = "pixshar_events";

type NotifyPayload =
  | { type: "photo.processed"; eventId: string; photoId: string }
  | { type: "photo.status"; eventId: string }
  | { type: "download.status"; eventId: string };

async function handleNotification(payload: NotifyPayload): Promise<void> {
  switch (payload.type) {
    case "photo.processed": {
      const { eventId, photoId } = payload;
      // Re-fetch photo to get the stored keys (worker already wrote them to DB).
      const photo = await prisma.photo.findUnique({
        where: { id: photoId },
        select: { thumbKey: true, displayKey: true, photographerName: true },
      });
      if (!photo?.thumbKey || !photo?.displayKey) break;
      try {
        const [thumbUrl, displayUrl] = await Promise.all([
          getPresignedUrl(photo.thumbKey, "get", 3600),
          getPresignedUrl(photo.displayKey, "get", 3600),
        ]);
        emitPhotoProcessed(eventId, {
          id: photoId,
          thumbUrl,
          displayUrl,
          photographerName: photo.photographerName,
        });
      } catch {
        // best-effort
      }
      await pushPhotoStatus(eventId).catch(() => {});
      break;
    }
    case "photo.status":
      await pushPhotoStatus(payload.eventId).catch(() => {});
      break;
    case "download.status":
      await pushDownloadStatus(payload.eventId).catch(() => {});
      break;
  }
}

export async function startPgNotifyListener(): Promise<void> {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });

  const connect = async (): Promise<void> => {
    try {
      await client.connect();
      await client.query(`LISTEN "${PG_NOTIFY_CHANNEL}"`);
      console.log(`[PgNotify] listening on channel "${PG_NOTIFY_CHANNEL}"`);

      client.on("notification", (msg) => {
        if (!msg.payload) return;
        let data: NotifyPayload;
        try {
          data = JSON.parse(msg.payload) as NotifyPayload;
        } catch {
          return;
        }
        handleNotification(data).catch((err) =>
          console.error("[PgNotify] handler error:", err)
        );
      });

      client.on("error", (err) => {
        console.error("[PgNotify] connection error:", err);
      });

      client.on("end", () => {
        console.log("[PgNotify] disconnected, reconnecting in 5s");
        // Create a new client instance on reconnect.
        setTimeout(() => startPgNotifyListener().catch(console.error), 5_000);
      });
    } catch (err) {
      console.error("[PgNotify] connect failed, retrying in 5s:", err);
      setTimeout(() => startPgNotifyListener().catch(console.error), 5_000);
    }
  };

  await connect();
}
