import { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
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
const s3Public = new S3Client({
  endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
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

export const s3Keys = {
  zip: (eventId: string) => `${eventId}/archive/gallery.zip`,
};
