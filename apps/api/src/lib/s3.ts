import { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { env } from "./env.js";

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

// Client used only to *sign* presigned URLs. These are consumed by the browser,
// so they must be signed against the externally reachable host — see
// S3_PUBLIC_ENDPOINT in env.ts. Falls back to the internal endpoint.
//
// forcePathStyle is env-driven (S3_FORCE_PATH_STYLE):
//  - Virtual-hosted (default, false): Tigris/R2 and most hosted providers need
//    bucket.host/key; path-style there causes a 307 that re-uploads the body.
//  - Path-style (true): MinIO — the bundled self-host store — has no per-bucket
//    virtual host, so virtual-hosted URLs resolve to `bucket.localhost` which
//    MinIO cannot route (404). The Docker/Helm MinIO setup sets this to true.
const s3Public = new S3Client({
  endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

export function getPublicUrl(key: string): string {
  if (env.S3_PUBLIC_URL) {
    return `${env.S3_PUBLIC_URL}/${key}`;
  }
  return `${env.S3_ENDPOINT}/${env.S3_BUCKET}/${key}`;
}

export async function getPresignedUrl(
  key: string,
  operation: "get" | "put" = "get",
  expiresIn = 3600,
  contentDisposition?: string
): Promise<string> {
  const command = operation === "get"
    ? new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        ...(contentDisposition ? { ResponseContentDisposition: contentDisposition } : {}),
      })
    : new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  return getSignedUrl(s3Public, command, { expiresIn });
}

// Presigned PUT URL for a direct browser → S3 upload. The signed ContentType
// must match the Content-Type header the browser sends, or S3 rejects the
// signature.
export async function getPresignedPutUrl(
  key: string,
  contentType: string,
  expiresIn = 900
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3Public, command, { expiresIn });
}

// Download an object's full bytes (server-side, internal endpoint).
export async function getS3Object(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteS3Object(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

// Delete an explicit list of keys in one round trip per 1000 (the DeleteObjects
// cap). Used to reclaim an archive's part objects: the keys are known from the
// part rows, so listing the bucket is unnecessary.
export async function deleteS3Objects(keys: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      })
    );
    deleted += batch.length;
  }
  return deleted;
}

// List every object key under a prefix (paginated).
export async function listS3Prefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const o of list.Contents ?? []) {
      if (o.Key) keys.push(o.Key);
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

// Delete every object under a prefix (paginated; DeleteObjects caps at 1000 keys).
export async function deleteS3Prefix(prefix: string): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const objects = (list.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: env.S3_BUCKET,
          Delete: { Objects: objects },
        })
      );
      deleted += objects.length;
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}

export const s3Keys = {
  archivePrefix: (eventId: string) => `${eventId}/archive/`,
  // The generation suffix lets a rebuilt part (same partIndex) be written under a
  // fresh key so the previous object stays downloadable until the new one lands.
  // The quality segment (DISPLAY / ORIGINAL) keeps the two variants' objects
  // apart under the shared archive prefix.
  zipPart: (
    eventId: string,
    quality: "DISPLAY" | "ORIGINAL",
    partIndex: number,
    generation: number
  ) => `${eventId}/archive/${quality}-part-${partIndex}-g${generation}.zip`,
  // Decide which variant owns a listed archive object, so a quality-scoped orphan
  // sweep never deletes the *other* variant's parts. Legacy objects written
  // before the quality dimension used the `gallery-part-` prefix and are ORIGINAL
  // (the old builder zipped originals).
  archiveKeyQuality: (
    eventId: string,
    key: string
  ): "DISPLAY" | "ORIGINAL" | null => {
    const prefix = `${eventId}/archive/`;
    if (!key.startsWith(prefix)) return null;
    const rest = key.slice(prefix.length);
    if (rest.startsWith("DISPLAY-part-")) return "DISPLAY";
    if (rest.startsWith("ORIGINAL-part-")) return "ORIGINAL";
    if (rest.startsWith("gallery-part-")) return "ORIGINAL"; // legacy
    return null;
  },
};
