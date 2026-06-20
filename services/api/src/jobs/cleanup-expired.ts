import path from "node:path";
import { readdir, readFile, rm } from "node:fs/promises";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { deleteStoredObject } from "../lib/storage.js";

type StoredUploadSession = {
  dir?: string;
  createdAt?: string;
  expiresAt?: string;
};

function expiresAtMs(session: StoredUploadSession): number {
  const explicit = session.expiresAt ? Date.parse(session.expiresAt) : Number.NaN;
  if (Number.isFinite(explicit)) return explicit;
  const createdAt = session.createdAt ? Date.parse(session.createdAt) : Number.NaN;
  return Number.isFinite(createdAt) ? createdAt + env.UPLOAD_SESSION_TTL_SECONDS * 1000 : 0;
}

export async function cleanupExpiredUploadSessions(now = new Date()): Promise<number> {
  let removed = 0;
  const root = path.resolve(env.UPLOAD_TMP_DIR);
  const users = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const user of users) {
    if (!user.isDirectory()) continue;
    const userDir = path.join(root, user.name);
    const sessions = await readdir(userDir, { withFileTypes: true }).catch(() => []);
    for (const sessionEntry of sessions) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = path.join(userDir, sessionEntry.name);
      const raw = await readFile(path.join(sessionDir, "session.json"), "utf8").catch(() => null);
      if (!raw) continue;
      const session = JSON.parse(raw) as StoredUploadSession;
      if (expiresAtMs(session) > now.getTime()) continue;
      await rm(sessionDir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export async function cleanupExpiredAssets(now = new Date(), limit = 500): Promise<number> {
  const assets = await prisma.fileAsset.findMany({
    where: { expiresAt: { lt: now } },
    orderBy: { expiresAt: "asc" },
    take: limit
  });

  let removed = 0;
  for (const asset of assets) {
    try {
      if (asset.kind === "ORIGINAL") {
        // Fix 18: Never delete an input asset that has QUEUED or RUNNING jobs.
        // Doing so would cascade-delete the job record (onDelete: Restrict) or
        // leave the worker with a missing file, causing it to fail mid-flight.
        const activeJobCount = await prisma.conversionJob.count({
          where: {
            inputAssetId: asset.id,
            status: { in: ["QUEUED", "RUNNING"] }
          }
        });
        if (activeJobCount > 0) {
          logger.warn(
            { assetId: asset.id, activeJobCount },
            "Skipping expired ORIGINAL asset — has active jobs referencing it"
          );
          continue;
        }
        await prisma.conversionJob.deleteMany({ where: { inputAssetId: asset.id } });
      } else {
        await prisma.conversionJob.updateMany({
          where: { outputAssetId: asset.id },
          data: { outputAssetId: null }
        });
      }
      await deleteStoredObject({
        storage: asset.storage,
        bucket: asset.bucket,
        key: asset.storageKey
      });
      await prisma.fileAsset.delete({ where: { id: asset.id } });
      removed += 1;
    } catch (error) {
      logger.warn({ assetId: asset.id, error }, "Expired asset cleanup skipped an asset");
    }
  }
  return removed;
}

export async function cleanupExpiredData(): Promise<{ uploadSessions: number; assets: number }> {
  const now = new Date();
  const [uploadSessions, assets] = await Promise.all([
    cleanupExpiredUploadSessions(now),
    cleanupExpiredAssets(now)
  ]);
  return { uploadSessions, assets };
}
