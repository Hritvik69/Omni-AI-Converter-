import { createReadStream } from "node:fs";
import path from "node:path";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

const s3DownloadClient = new S3Client({
  region: env.AWS_REGION,
  endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY
        }
      : undefined
});

export type PutFileResult = {
  bucket: string;
  key: string;
  sizeBytes: number;
  etag?: string;
};

export function storageKind(): "S3" | "LOCAL" {
  return env.STORAGE_DRIVER === "local" ? "LOCAL" : "S3";
}

export function isLocalStorage(): boolean {
  return env.STORAGE_DRIVER === "local";
}

export function localStoragePath(key: string): string {
  const baseDir = path.resolve(env.LOCAL_STORAGE_DIR);
  const resolved = path.resolve(baseDir, key);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return resolved;
}

export async function putLocalFileToS3(args: {
  localPath: string;
  key: string;
  mimeType: string;
  metadata?: Record<string, string>;
}): Promise<PutFileResult> {
  const fileStat = await stat(args.localPath);
  if (isLocalStorage()) {
    const outputPath = localStoragePath(args.key);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await copyFile(args.localPath, outputPath);
    return {
      bucket: "local",
      key: args.key,
      sizeBytes: fileStat.size
    };
  }

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

export async function getDownloadUrl(args: { bucket?: string | null; key: string; fileName?: string }): Promise<string> {
  // Fix 14: Use RFC 5987 encoding (filename*=UTF-8'') for non-ASCII filenames.
  // The fallback ASCII name strips control chars, quotes, and non-printable
  // characters to prevent Content-Disposition header injection.
  function rfc5987ContentDisposition(fileName: string): string {
    const safe = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\%/]/g, "_");
    const encoded = encodeURIComponent(fileName);
    return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
  }

  return getSignedUrl(
    s3DownloadClient,
    new GetObjectCommand({
      Bucket: args.bucket ?? env.S3_BUCKET,
      Key: args.key,
      ResponseContentDisposition: args.fileName
        ? rfc5987ContentDisposition(args.fileName)
        : undefined
    }),
    { expiresIn: env.SIGNED_URL_TTL_SECONDS }
  );
}

export async function deleteStoredObject(args: { storage: "S3" | "LOCAL"; bucket?: string | null; key: string }): Promise<void> {
  if (args.storage === "LOCAL" || isLocalStorage()) {
    await rm(localStoragePath(args.key), { force: true });
    return;
  }

  await s3.send(
    new DeleteObjectCommand({
      Bucket: args.bucket ?? env.S3_BUCKET,
      Key: args.key
    })
  );
}
