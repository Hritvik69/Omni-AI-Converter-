import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";

export const s3 = new S3Client({
  region: env.AWS_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY
        }
      : undefined
});

export async function downloadS3ObjectToFile(args: {
  bucket?: string | null;
  key: string;
  localPath: string;
}): Promise<void> {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: args.bucket ?? env.S3_BUCKET,
      Key: args.key
    })
  );
  if (!response.Body) throw new Error(`S3 object has no body: ${args.key}`);
  await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(args.localPath));
}

export async function putLocalFileToS3(args: {
  localPath: string;
  key: string;
  mimeType: string;
  metadata?: Record<string, string>;
}): Promise<{ bucket: string; key: string; sizeBytes: number; etag?: string }> {
  const fileStat = await stat(args.localPath);
  const result = await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: args.key,
      Body: createReadStream(args.localPath),
      ContentLength: fileStat.size,
      ContentType: args.mimeType,
      Metadata: args.metadata
    })
  );
  return {
    bucket: env.S3_BUCKET,
    key: args.key,
    sizeBytes: fileStat.size,
    etag: result.ETag?.replaceAll('"', "")
  };
}
