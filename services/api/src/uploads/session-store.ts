import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { HttpError } from "../http/middleware/errors.js";

export type UploadSession = {
  uploadId: string;
  userId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  checksumSha256?: string;
  chunkSize: number;
  dir: string;
  createdAt: string;
  expiresAt: string;
};

export async function createUploadSession(args: {
  userId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  checksumSha256?: string;
}): Promise<UploadSession> {
  if (args.fileSize > env.MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "File exceeds maximum upload size");
  }

  const uploadId = randomUUID();
  const dir = path.resolve(env.UPLOAD_TMP_DIR, args.userId, uploadId);
  await mkdir(dir, { recursive: true });

  const session: UploadSession = {
    uploadId,
    userId: args.userId,
    fileName: args.fileName,
    fileSize: args.fileSize,
    mimeType: args.mimeType,
    checksumSha256: args.checksumSha256,
    chunkSize: env.UPLOAD_CHUNK_BYTES,
    dir,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + env.UPLOAD_SESSION_TTL_SECONDS * 1000).toISOString()
  };

  await writeFile(path.join(dir, "session.json"), JSON.stringify(session, null, 2), "utf8");
  return session;
}

export async function getUploadSession(uploadId: string, userId: string): Promise<UploadSession> {
  const dir = path.resolve(env.UPLOAD_TMP_DIR, userId, uploadId);
  try {
    const raw = await readFile(path.join(dir, "session.json"), "utf8");
    const session = JSON.parse(raw) as UploadSession;
    if (session.userId !== userId || session.uploadId !== uploadId) {
      throw new HttpError(403, "Upload session does not belong to this user");
    }
    const expiresAt =
      Date.parse(session.expiresAt) ||
      (Date.parse(session.createdAt) + env.UPLOAD_SESSION_TTL_SECONDS * 1000);
    if (expiresAt <= Date.now()) {
      await deleteUploadSession(session);
      throw new HttpError(410, "Upload session expired");
    }
    return session;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "Upload session not found");
  }
}

export async function deleteUploadSession(session: UploadSession): Promise<void> {
  await rm(session.dir, { recursive: true, force: true });
}
