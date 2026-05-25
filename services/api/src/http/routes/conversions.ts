import { Router } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import archiver from "archiver";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { ConversionJob, FileAsset, Prisma } from "@prisma/client";
import {
  createAiJobSchema,
  createConversionSchema,
  type JobProgressEvent
} from "@omniconvert/shared";
import { prisma } from "../../lib/prisma.js";
import { conversionQueue } from "../../lib/queue.js";
import { getDownloadUrl, localStoragePath, s3 } from "../../lib/storage.js";
import { env } from "../../config/env.js";
import { publishJobEvent } from "../../realtime/events.js";
import { assertConversionTarget } from "../../validation/file-policy.js";
import { HttpError } from "../middleware/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requiredParam } from "../params.js";

export const conversionsRouter = Router();

type JobWithAssets = Prisma.ConversionJobGetPayload<{
  include: { inputAsset: true; outputAsset: true };
}>;

function jobDto(job: ConversionJob) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    sourceFormat: job.sourceFormat,
    targetFormat: job.targetFormat,
    tool: job.tool,
    error: job.error,
    inputAssetId: job.inputAssetId,
    outputAssetId: job.outputAssetId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt
  };
}

function apiBaseUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  const configured = env.PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function localAssetDownloadUrl(
  req: { protocol: string; get(name: string): string | undefined },
  assetId: string
): string {
  return `${apiBaseUrl(req)}/api/conversions/assets/${assetId}/download-file`;
}

async function assetDownloadUrl(
  req: { protocol: string; get(name: string): string | undefined },
  asset: FileAsset
): Promise<string> {
  if (asset.storage === "LOCAL") return localAssetDownloadUrl(req, asset.id);
  return getDownloadUrl(asset.storageKey, asset.originalName);
}

async function emitQueued(userId: string, jobId: string): Promise<void> {
  const event: JobProgressEvent = {
    jobId,
    status: "queued",
    progress: 0,
    stage: "queued"
  };
  await publishJobEvent(userId, event);
}

conversionsRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const input = createConversionSchema.parse(req.body);
    const jobs = [];

    for (const file of input.files) {
      const asset = await prisma.fileAsset.findFirst({
        where: { id: file.uploadId, userId: req.authUser.id, kind: "ORIGINAL" }
      });
      if (!asset) throw new HttpError(404, `Upload not found: ${file.uploadId}`);
      const targetFormat = assertConversionTarget(asset.extension, file.targetFormat);

      const job = await prisma.conversionJob.create({
        data: {
          userId: req.authUser.id,
          kind: "CONVERSION",
          status: "QUEUED",
          sourceFormat: asset.extension,
          targetFormat,
          inputAssetId: asset.id,
          options: file.options
        }
      });

      const queued = await conversionQueue.add("convert", { conversionJobId: job.id }, { jobId: job.id });
      await prisma.conversionJob.update({
        where: { id: job.id },
        data: { queueJobId: queued.id }
      });
      await emitQueued(req.authUser.id, job.id);
      jobs.push(jobDto(job));
    }

    res.status(202).json({ jobs });
  } catch (error) {
    next(error);
  }
});

conversionsRouter.post("/ai", requireAuth, async (req, res, next) => {
  try {
    const input = createAiJobSchema.parse(req.body);
    const asset = await prisma.fileAsset.findFirst({
      where: { id: input.uploadId, userId: req.authUser.id, kind: "ORIGINAL" }
    });
    if (!asset) throw new HttpError(404, `Upload not found: ${input.uploadId}`);

    const targetByTool: Record<string, string> = {
      ocr: "txt",
      "pdf-summary": "txt",
      "speech-to-text": "txt",
      "subtitle-generator": "srt",
      "image-upscale": asset.extension,
      "background-remove": "png",
      "document-analyzer": "json",
      "file-repair": asset.extension
    };

    const job = await prisma.conversionJob.create({
      data: {
        userId: req.authUser.id,
        kind: "AI",
        status: "QUEUED",
        sourceFormat: asset.extension,
        targetFormat: targetByTool[input.tool] ?? "txt",
        tool: input.tool,
        inputAssetId: asset.id,
        options: input.options
      }
    });

    const queued = await conversionQueue.add("ai", { conversionJobId: job.id }, { jobId: job.id });
    await prisma.conversionJob.update({
      where: { id: job.id },
      data: { queueJobId: queued.id }
    });
    await emitQueued(req.authUser.id, job.id);

    res.status(202).json({ job: jobDto(job) });
  } catch (error) {
    next(error);
  }
});

conversionsRouter.get("/history", requireAuth, async (req, res, next) => {
  try {
    const jobs = await prisma.conversionJob.findMany({
      where: { userId: req.authUser.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { inputAsset: true, outputAsset: true }
    });

    res.json({
      jobs: await Promise.all(
        jobs.map(async (job) => ({
          id: job.id,
          kind: job.kind,
          status: job.status,
          progress: job.progress,
          stage: job.stage,
          sourceFormat: job.sourceFormat,
          targetFormat: job.targetFormat,
          tool: job.tool,
          error: job.error,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
          input: {
            id: job.inputAsset.id,
            name: job.inputAsset.originalName,
            sizeBytes: Number(job.inputAsset.sizeBytes)
          },
          output: job.outputAsset
            ? {
                id: job.outputAsset.id,
                name: job.outputAsset.originalName,
                sizeBytes: Number(job.outputAsset.sizeBytes),
                downloadUrl: await assetDownloadUrl(req, job.outputAsset)
              }
            : null
        }))
      )
    });
  } catch (error) {
    next(error);
  }
});

conversionsRouter.get("/assets/:assetId/download", requireAuth, async (req, res, next) => {
  try {
    const assetId = requiredParam(req.params.assetId, "assetId");
    const asset = await prisma.fileAsset.findFirst({
      where: { id: assetId, userId: req.authUser.id }
    });
    if (!asset) throw new HttpError(404, "Asset not found");

    res.json({
      downloadUrl: await assetDownloadUrl(req, asset),
      expiresInSeconds: env.SIGNED_URL_TTL_SECONDS
    });
  } catch (error) {
    next(error);
  }
});

conversionsRouter.get("/assets/:assetId/download-file", requireAuth, async (req, res, next) => {
  try {
    const assetId = requiredParam(req.params.assetId, "assetId");
    const asset = await prisma.fileAsset.findFirst({
      where: { id: assetId, userId: req.authUser.id }
    });
    if (!asset) throw new HttpError(404, "Asset not found");

    if (asset.storage !== "LOCAL") {
      res.redirect(await getDownloadUrl(asset.storageKey, asset.originalName));
      return;
    }

    const localPath = localStoragePath(asset.storageKey);
    await stat(localPath);
    res.setHeader("Content-Type", asset.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", Number(asset.sizeBytes).toString());
    res.setHeader("Content-Disposition", `attachment; filename="${asset.originalName.replaceAll('"', "")}"`);
    createReadStream(localPath).pipe(res);
  } catch (error) {
    next(error);
  }
});

conversionsRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = requiredParam(req.params.id, "id");
    const job: JobWithAssets | null = await prisma.conversionJob.findFirst({
      where: { id, userId: req.authUser.id },
      include: { outputAsset: true, inputAsset: true }
    });
    if (!job) throw new HttpError(404, "Conversion job not found");

    res.json({
      job: {
        id: job.id,
        kind: job.kind,
        status: job.status,
        progress: job.progress,
        stage: job.stage,
        sourceFormat: job.sourceFormat,
        targetFormat: job.targetFormat,
        tool: job.tool,
        error: job.error,
        input: { id: job.inputAsset.id, name: job.inputAsset.originalName },
        output: job.outputAsset
          ? {
              id: job.outputAsset.id,
              name: job.outputAsset.originalName,
              downloadUrl: await assetDownloadUrl(req, job.outputAsset)
            }
          : null
      }
    });
  } catch (error) {
    next(error);
  }
});

conversionsRouter.post("/zip", requireAuth, async (req, res, next) => {
  try {
    const input = z.object({ jobIds: z.array(z.string().uuid()).min(1).max(100) }).parse(req.body);
    const jobs = await prisma.conversionJob.findMany({
      where: {
        id: { in: input.jobIds },
        userId: req.authUser.id,
        status: "COMPLETED",
        outputAssetId: { not: null }
      },
      include: { outputAsset: true }
    });

    if (jobs.length === 0) throw new HttpError(404, "No completed outputs found for ZIP export");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="omniconvert-results-${Date.now()}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", next);
    archive.pipe(res);

    for (const job of jobs) {
      if (!job.outputAsset) continue;
      if (job.outputAsset.storage === "LOCAL") {
        archive.append(createReadStream(localStoragePath(job.outputAsset.storageKey)), {
          name: job.outputAsset.originalName
        });
        continue;
      }

      const object = await s3.send(
        new GetObjectCommand({
          Bucket: job.outputAsset.bucket ?? env.S3_BUCKET,
          Key: job.outputAsset.storageKey
        })
      );
      archive.append(object.Body as Readable, {
        name: job.outputAsset.originalName
      });
    }

    await archive.finalize();
  } catch (error) {
    next(error);
  }
});
