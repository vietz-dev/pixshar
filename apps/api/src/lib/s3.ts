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
// forcePathStyle is intentionally NOT set here: Tigris (and most hosted S3
// providers) use virtual-hosted style (bucket.host/key). Path-style presigned
// URLs cause a 307 redirect on those providers, making the browser re-upload
// the entire file body a second time — doubling upload time.
const s3Public = new S3Client({
  endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
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
  zipPart: (eventId: string, partIndex: number) =>
    `${eventId}/archive/gallery-part-${partIndex}.zip`,
};
