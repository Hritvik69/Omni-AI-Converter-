import crypto from "node:crypto";
import { Router } from "express";
import {
  completeUploadSchema,
  createUploadSessionSchema
} from "@omniconvert/shared";
import { createUploadSession, deleteUploadSession, getUploadSession } from "../../uploads/session-store.js";
import { mergeChunks, writeChunkFromRequest } from "../../uploads/chunks.js";
import { validateCompletedFile, sanitizeFileName } from "../../validation/file-policy.js";
import { scanForMalware } from "../../lib/scan.js";
import { putLocalFileToS3, storageKind } from "../../lib/storage.js";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadRateLimit } from "../middleware/security.js";
import { requiredParam } from "../params.js";

export const uploadsRouter = Router();

uploadsRouter.post("/sessions", requireAuth, uploadRateLimit, async (req, res, next) => {
  try {
    const input = createUploadSessionSchema.parse(req.body);
    const session = await createUploadSession({
      userId: req.authUser.id,
      fileName: sanitizeFileName(input.fileName),
      fileSize: input.fileSize,
      mimeType: input.mimeType,
      checksumSha256: input.checksumSha256
    });

    res.status(201).json({
      uploadId: session.uploadId,
      chunkSize: session.chunkSize,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    next(error);
  }
});

uploadsRouter.put("/:uploadId/chunks/:index", requireAuth, uploadRateLimit, async (req, res, next) => {
  try {
    req.setTimeout(1000 * 60 * 5);
    const uploadId = requiredParam(req.params.uploadId, "uploadId");
    const index = Number(requiredParam(req.params.index, "index"));
    const session = await getUploadSession(uploadId, req.authUser.id);
    const result = await writeChunkFromRequest(req, session, index);
    res.status(201).json({ ok: true, index, sizeBytes: result.sizeBytes });
  } catch (error) {
    next(error);
  }
});

uploadsRouter.post("/:uploadId/complete", requireAuth, uploadRateLimit, async (req, res, next) => {
  try {
    const uploadId = requiredParam(req.params.uploadId, "uploadId");
    const session = await getUploadSession(uploadId, req.authUser.id);
    const input = completeUploadSchema.parse(req.body);
    const merged = await mergeChunks(session, input.totalChunks);
    const expectedHash = input.checksumSha256 ?? session.checksumSha256;

    if (expectedHash && expectedHash.toLowerCase() !== merged.checksumSha256) {
      throw new HttpError(422, "SHA-256 checksum mismatch");
    }

    const validated = await validateCompletedFile({
      localPath: merged.mergedPath,
      originalName: session.fileName,
      declaredMimeType: session.mimeType,
      maxBytes: env.MAX_UPLOAD_BYTES,
      sizeBytes: merged.sizeBytes
    });

    await scanForMalware(merged.mergedPath);

    // Fix 11: Deduplicate uploads — if an identical file (same user + SHA-256)
    // was already uploaded and is not expired, return the existing asset
    // instead of creating a duplicate S3 object and FileAsset row.
    if (merged.checksumSha256) {
      const existingAsset = await prisma.fileAsset.findFirst({
        where: {
          userId: req.authUser.id,
          checksumSha256: merged.checksumSha256,
          kind: "ORIGINAL",
          expiresAt: { gt: new Date() }
        }
      });
      if (existingAsset) {
        await deleteUploadSession(session);
        return res.status(200).json({
          assetId: existingAsset.id,
          uploadId: session.uploadId,
          fileName: existingAsset.originalName,
          mimeType: existingAsset.mimeType,
          extension: existingAsset.extension,
          sizeBytes: Number(existingAsset.sizeBytes)
        });
      }
    }

    const storageKey = `users/${req.authUser.id}/originals/${session.uploadId}/${sanitizeFileName(session.fileName)}`;
    const stored = await putLocalFileToS3({
      localPath: merged.mergedPath,
      key: storageKey,
      mimeType: validated.detectedMimeType,
      metadata: {
        checksumSha256: merged.checksumSha256,
        uploadId: session.uploadId
      }
    });

    const asset = await prisma.fileAsset.create({
      data: {
        id: session.uploadId,
        userId: req.authUser.id,
        kind: "ORIGINAL",
        storage: storageKind(),
        bucket: stored.bucket,
        storageKey: stored.key,
        originalName: session.fileName,
        mimeType: validated.detectedMimeType,
        extension: validated.extension,
        sizeBytes: BigInt(stored.sizeBytes),
        checksumSha256: merged.checksumSha256,
        etag: stored.etag,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
      }
    });

    await deleteUploadSession(session);

    res.status(201).json({
      assetId: asset.id,
      uploadId: session.uploadId,
      fileName: asset.originalName,
      mimeType: asset.mimeType,
      extension: asset.extension,
      sizeBytes: stored.sizeBytes
    });
  } catch (error) {
    next(error);
  }
});

uploadsRouter.post("/:uploadId/abort", requireAuth, async (req, res, next) => {
  try {
    const uploadId = requiredParam(req.params.uploadId, "uploadId");
    const session = await getUploadSession(uploadId, req.authUser.id);
    await deleteUploadSession(session);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
