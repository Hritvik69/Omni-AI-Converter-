import { Router } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import archiver from "archiver";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { ConversionJob, FileAsset, Prisma } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import {
  conversionOptionsSchema,
  createAiJobSchema,
  createConversionSchema,
  uniqueConversionTargetsFor,
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
  return getDownloadUrl({ bucket: asset.bucket, key: asset.storageKey, fileName: asset.originalName });
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

async function failCreatedJobsAfterEnqueueError(jobs: Array<{ id: string; userId: string }>, error: unknown): Promise<void> {
  if (!jobs.length) return;
  const message = error instanceof Error ? error.message : "Queue enqueue failed";
  await prisma.conversionJob.updateMany({
    where: { id: { in: jobs.map((job) => job.id) }, status: "QUEUED" },
    data: {
      status: "FAILED",
      progress: 100,
      stage: "failed",
      error: `Queue enqueue failed: ${message.slice(0, 300)}`,
      completedAt: new Date()
    }
  });
  await Promise.all(
    jobs.map((job) =>
      publishJobEvent(job.userId, {
        jobId: job.id,
        status: "failed",
        progress: 100,
        stage: "failed",
        error: "Queue enqueue failed"
      })
    )
  );
}

// Fix 14: RFC 6266-compliant Content-Disposition encoding.
// Strips control characters and non-printable ASCII for the fallback name,
// then encodes the full filename as RFC 5987 filename* to support Unicode.
function safeContentDisposition(fileName: string): string {
  const safe = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["%\\/]/g, "_");
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

conversionsRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const input = createConversionSchema.parse(req.body);
    const preset = input.presetId
      ? await prisma.conversionPreset.findFirst({
          where: { id: input.presetId, userId: req.authUser.id }
        })
      : null;
    if (input.presetId && !preset) throw new HttpError(404, "Preset not found");
    const presetOptions = preset ? conversionOptionsSchema.parse(preset.options ?? {}) : {};

    // Fix 2: Demo user job cap — prevents unlimited free conversions
    const isDemoUser = req.authUser.clerkId.startsWith("demo-user:");
    if (isDemoUser) {
      const recentJobs = await prisma.conversionJob.count({
        where: {
          userId: req.authUser.id,
          createdAt: { gte: new Date(Date.now() - 1000 * 60 * 60 * 24) }
        }
      });
      const demoLimit = Number(process.env.DEMO_MAX_JOBS_PER_DAY ?? "5");
      if (recentJobs >= demoLimit) {
        throw new HttpError(429, "Demo quota exceeded. Sign up for a free account to continue.");
      }
    }

    const plannedJobs: Array<{
      asset: FileAsset;
      targetFormat: string;
      options: (typeof input.files)[number]["options"];
    }> = [];

    for (const file of input.files) {
      const asset = await prisma.fileAsset.findFirst({
        where: { id: file.uploadId, userId: req.authUser.id, kind: "ORIGINAL" }
      });
      if (!asset) throw new HttpError(404, `Upload not found: ${file.uploadId}`);
      const requestedTargetFormat = file.targetFormat ?? preset?.target;
      if (!requestedTargetFormat) {
        throw new HttpError(422, "targetFormat is required when no preset supplies a target");
      }
      const targetFormats =
        requestedTargetFormat.trim().toLowerCase() === "all"
          ? uniqueConversionTargetsFor(asset.extension)
          : [requestedTargetFormat];
      if (!targetFormats.length) throw new HttpError(415, `No supported conversion targets for ${asset.extension}`);

      for (const requestedTarget of targetFormats) {
        plannedJobs.push({
          asset,
          targetFormat: assertConversionTarget(asset.extension, requestedTarget),
          options: {
            ...presetOptions,
            ...file.options
          }
        });
      }
    }

    if (plannedJobs.length > 100) {
      throw new HttpError(422, "A conversion request can create up to 100 jobs");
    }

    const createdJobs = await prisma.$transaction(
      plannedJobs.map((plannedJob) => {
        const id = uuidv4();
        return prisma.conversionJob.create({
          data: {
            id,
            userId: req.authUser.id,
            kind: "CONVERSION",
            status: "QUEUED",
            queueJobId: id,
            sourceFormat: plannedJob.asset.extension,
            targetFormat: plannedJob.targetFormat,
            inputAssetId: plannedJob.asset.id,
            options: plannedJob.options
          }
        });
      })
    );
    const jobs = createdJobs.map(jobDto);

    try {
      await conversionQueue.addBulk(
        jobs.map((job) => ({
          name: "convert",
          data: { conversionJobId: job.id },
          opts: { jobId: job.id }
        }))
      );
    } catch (error) {
      await failCreatedJobsAfterEnqueueError(createdJobs, error);
      throw new HttpError(503, "Conversion queue is temporarily unavailable");
    }
    await Promise.all(jobs.map((job) => emitQueued(req.authUser.id, job.id)));

    res.status(202).json({ jobs });
  } catch (error) {
    next(error);
  }
});

conversionsRouter.get("/auth/session", requireAuth, (_req, res) => {
  res.json({ ok: true });
});

conversionsRouter.post("/ai", requireAuth, async (req, res, next) => {
  try {
    const input = createAiJobSchema.parse(req.body);
    const asset = await prisma.fileAsset.findFirst({
      where: { id: input.uploadId, userId: req.authUser.id, kind: "ORIGINAL" }
    });
    if (!asset) throw new HttpError(404, `Upload not found: ${input.uploadId}`);

    // Fix 2: Demo user job cap on AI jobs
    const isDemoUser = req.authUser.clerkId.startsWith("demo-user:");
    if (isDemoUser) {
      const recentJobs = await prisma.conversionJob.count({
        where: {
          userId: req.authUser.id,
          createdAt: { gte: new Date(Date.now() - 1000 * 60 * 60 * 24) }
        }
      });
      const demoLimit = Number(process.env.DEMO_MAX_JOBS_PER_DAY ?? "5");
      if (recentJobs >= demoLimit) {
        throw new HttpError(429, "Demo quota exceeded. Sign up for a free account to continue.");
      }
    }

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

    // Fix 17: Reject unknown AI tools instead of silently falling back to "txt"
    if (!(input.tool in targetByTool)) {
      throw new HttpError(422, `Unknown AI tool: ${input.tool}`);
    }

    const jobId = uuidv4();
    const job = await prisma.conversionJob.create({
      data: {
        id: jobId,
        userId: req.authUser.id,
        kind: "AI",
        status: "QUEUED",
        queueJobId: jobId,
        sourceFormat: asset.extension,
        targetFormat: targetByTool[input.tool]!,
        tool: input.tool,
        inputAssetId: asset.id,
        options: input.options
      }
    });

    try {
      await conversionQueue.add("ai", { conversionJobId: job.id }, { jobId: job.id });
    } catch (error) {
      await failCreatedJobsAfterEnqueueError([job], error);
      throw new HttpError(503, "Conversion queue is temporarily unavailable");
    }
    await emitQueued(req.authUser.id, job.id);

    res.status(202).json({ job: jobDto(job) });
  } catch (error) {
    next(error);
  }
});

// Fix 5: History endpoint no longer generates signed download URLs inline.
// Generating 100 signed URLs concurrently saturates the event loop (CPU-bound HMAC).
// Clients should call /assets/:id/download on-demand when the user clicks download.
conversionsRouter.get("/history", requireAuth, async (req, res, next) => {
  try {
    const jobs = await prisma.conversionJob.findMany({
      where: { userId: req.authUser.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { inputAsset: true, outputAsset: true }
    });

    res.json({
      jobs: jobs.map((job) => ({
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
        // Fix 5: Return outputAssetId only — client fetches download URL on-demand
        output: job.outputAsset
          ? {
              id: job.outputAsset.id,
              name: job.outputAsset.originalName,
              sizeBytes: Number(job.outputAsset.sizeBytes)
            }
          : null
      }))
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
      res.redirect(await getDownloadUrl({ bucket: asset.bucket, key: asset.storageKey, fileName: asset.originalName }));
      return;
    }

    const localPath = localStoragePath(asset.storageKey);
    await stat(localPath);
    res.setHeader("Content-Type", asset.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", Number(asset.sizeBytes).toString());
    // Fix 14: Use RFC 5987-compliant Content-Disposition encoding
    res.setHeader("Content-Disposition", safeContentDisposition(asset.originalName));
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
    // Fix 4: 10-minute timeout for large ZIP exports
    req.setTimeout(1000 * 60 * 10);

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

    // Fix 4: Validate all S3 objects exist BEFORE opening the response stream.
    // This prevents sending a corrupt partial ZIP when an object is missing.
    const s3Jobs = jobs.filter((job) => job.outputAsset && job.outputAsset.storage !== "LOCAL");
    if (s3Jobs.length > 0) {
      const headResults = await Promise.allSettled(
        s3Jobs.map((job) =>
          s3.send(
            new HeadObjectCommand({
              Bucket: job.outputAsset!.bucket ?? env.S3_BUCKET,
              Key: job.outputAsset!.storageKey
            })
          )
        )
      );
      const missingIndex = headResults.findIndex((r) => r.status === "rejected");
      if (missingIndex !== -1) {
        const missingJob = s3Jobs[missingIndex];
        throw new HttpError(409, `Output asset is no longer available: ${missingJob?.outputAsset?.originalName ?? "unknown"}`);
      }
    }

    // Fix 4: Deduplicate file names by appending asset ID prefix on collision
    const usedNames = new Map<string, number>();
    function uniqueFileName(originalName: string, assetId: string): string {
      const count = usedNames.get(originalName) ?? 0;
      usedNames.set(originalName, count + 1);
      if (count === 0) return originalName;
      const dotIdx = originalName.lastIndexOf(".");
      const base = dotIdx >= 0 ? originalName.slice(0, dotIdx) : originalName;
      const ext = dotIdx >= 0 ? originalName.slice(dotIdx) : "";
      return `${base}-${assetId.slice(0, 6)}${ext}`;
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="omniconvert-results-${Date.now()}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", next);
    archive.pipe(res);

    for (const job of jobs) {
      if (!job.outputAsset) continue;
      const fileName = uniqueFileName(job.outputAsset.originalName, job.outputAsset.id);

      if (job.outputAsset.storage === "LOCAL") {
        archive.append(createReadStream(localStoragePath(job.outputAsset.storageKey)), {
          name: fileName
        });
        continue;
      }

      const object = await s3.send(
        new GetObjectCommand({
          Bucket: job.outputAsset.bucket ?? env.S3_BUCKET,
          Key: job.outputAsset.storageKey
        })
      );
      // Fix 4: Guard against missing Body (deleted object between HeadObject and GetObject)
      if (!object.Body) throw new Error(`S3 object body missing for asset ${job.outputAsset.id}`);
      archive.append(object.Body as Readable, {
        name: fileName
      });
    }

    await archive.finalize();
  } catch (error) {
    next(error);
  }
});
