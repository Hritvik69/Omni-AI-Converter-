import path from "node:path";
import { stat } from "node:fs/promises";
import { lookup as lookupMime } from "mime-types";
import { conversionOptionsSchema, type AiToolId, type ConversionOptions } from "@omniconvert/shared";
import { prisma } from "../lib/prisma.js";
import { downloadS3ObjectToFile, putLocalFileToS3, storageKind } from "../lib/storage.js";
import { withTempDir } from "../lib/temp.js";
import { updateJobProgress } from "./progress.js";
import { deliverJobWebhooks } from "./webhooks.js";
import { convertImage } from "../engines/image.js";
import { convertDocument } from "../engines/document.js";
import { convertPresentation } from "../engines/presentation.js";
import { convertAudio, convertVideo } from "../engines/media.js";
import { runAiTool } from "../engines/ai.js";
import {
  isAudio,
  isDocument,
  isImage,
  isPresentation,
  isVideo,
  normalizeExt
} from "../engines/formats.js";

function outputMime(extension: string): string {
  if (extension === "srt") return "application/x-subrip";
  if (extension === "json") return "application/json";
  return lookupMime(extension) || "application/octet-stream";
}

function outputName(originalName: string, targetFormat: string): string {
  const base = path.basename(originalName, path.extname(originalName)).replace(/[^\w.\- ()]/g, "_");
  return `${base}.${targetFormat}`;
}

async function dispatchConversion(args: {
  inputPath: string;
  outputPath: string;
  sourceFormat: string;
  targetFormat: string;
  workDir: string;
  options: ConversionOptions;
  onProgress: (progress: number, stage: string) => Promise<void>;
}) {
  const source = normalizeExt(args.sourceFormat);
  const target = normalizeExt(args.targetFormat);

  if ((isVideo(source) || isAudio(source)) && isAudio(target)) {
    await convertAudio({ ...args, targetFormat: target });
    return;
  }

  if (isVideo(source) && isVideo(target)) {
    await convertVideo({ ...args, targetFormat: target });
    return;
  }

  if (isDocument(source) && (["png", "jpg"].includes(target) || target === "pptx")) {
    const pdfPath =
      source === "pdf"
        ? args.inputPath
        : path.join(args.workDir, `document-bridge-${Date.now()}.pdf`);

    if (source !== "pdf") {
      await args.onProgress(20, "bridge: rendering document to pdf");
      await convertDocument({
        ...args,
        outputPath: pdfPath,
        inputFormat: source,
        targetFormat: "pdf"
      });
    }

    await convertPresentation({
      ...args,
      inputPath: pdfPath,
      inputFormat: "pdf",
      targetFormat: target
    });
    return;
  }

  if (isPresentation(source) || (source === "pdf" && target === "pptx")) {
    await convertPresentation({ ...args, inputFormat: source, targetFormat: target });
    return;
  }

  if (isImage(source) && isImage(target)) {
    await convertImage({ ...args, inputFormat: source, targetFormat: target });
    return;
  }

  if (isDocument(source) && isDocument(target)) {
    await convertDocument({ ...args, inputFormat: source, targetFormat: target });
    return;
  }

  throw new Error(`Unsupported conversion path: ${source} -> ${target}`);
}

export async function processConversionJob(
  conversionJobId: string,
  options: { willRetryOnFailure?: boolean } = {}
): Promise<void> {
  const job = await prisma.conversionJob.findUnique({
    where: { id: conversionJobId },
    include: { inputAsset: true }
  });
  if (!job) throw new Error(`Conversion job not found: ${conversionJobId}`);

  await updateJobProgress({
    userId: job.userId,
    jobId: job.id,
    status: "running",
    progress: 3,
    stage: "worker: reserving isolated workspace"
  });

  try {
    await withTempDir(job.id, async (workDir) => {
      const source = normalizeExt(job.sourceFormat);
      const target = normalizeExt(job.targetFormat);
      const inputPath = path.join(workDir, `input.${source}`);
      const outputFileName = outputName(job.inputAsset.originalName, target);
      const outputPath = path.join(workDir, outputFileName);
      const options = conversionOptionsSchema.parse(job.options ?? {});

      await downloadS3ObjectToFile({
        bucket: job.inputAsset.bucket,
        key: job.inputAsset.storageKey,
        localPath: inputPath
      });

      await updateJobProgress({
        userId: job.userId,
        jobId: job.id,
        status: "running",
        progress: 9,
        stage: "worker: source asset downloaded"
      });

      const progress = (progressValue: number, stage: string) =>
        updateJobProgress({
          userId: job.userId,
          jobId: job.id,
          status: "running",
          progress: progressValue,
          stage
        });

      if (job.kind === "AI") {
        if (!job.tool) throw new Error("AI job is missing tool identifier");
        await runAiTool({
          tool: job.tool as AiToolId,
          inputPath,
          inputFormat: source,
          outputPath,
          workDir,
          options,
          onProgress: progress
        });
      } else {
        await dispatchConversion({
          inputPath,
          outputPath,
          sourceFormat: source,
          targetFormat: target,
          workDir,
          options,
          onProgress: progress
        });
      }

      const outputStat = await stat(outputPath);
      if (!outputStat.size) throw new Error("Conversion engine produced an empty output file");

      await updateJobProgress({
        userId: job.userId,
        jobId: job.id,
        status: "running",
        progress: 96,
        stage: "worker: uploading output asset"
      });

      const storageKey = `users/${job.userId}/outputs/${job.id}/${outputFileName}`;
      const stored = await putLocalFileToS3({
        localPath: outputPath,
        key: storageKey,
        mimeType: outputMime(target),
        metadata: {
          sourceAssetId: job.inputAssetId,
          conversionJobId: job.id
        }
      });

      const asset = await prisma.fileAsset.create({
        data: {
          userId: job.userId,
          kind: "OUTPUT",
          storage: storageKind(),
          bucket: stored.bucket,
          storageKey: stored.key,
          originalName: outputFileName,
          mimeType: outputMime(target),
          extension: target,
          sizeBytes: BigInt(stored.sizeBytes),
          etag: stored.etag,
          metadata: {
            sourceAssetId: job.inputAssetId,
            conversionJobId: job.id
          },
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
        }
      });

      await updateJobProgress({
        userId: job.userId,
        jobId: job.id,
        status: "completed",
        progress: 100,
        stage: "completed",
        outputAssetId: asset.id
      });

      await deliverJobWebhooks({
        userId: job.userId,
        jobId: job.id,
        status: "COMPLETED",
        payload: {
          outputAssetId: asset.id,
          outputName: asset.originalName,
          targetFormat: asset.extension,
          sizeBytes: Number(asset.sizeBytes)
        }
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown conversion error";
    await updateJobProgress({
      userId: job.userId,
      jobId: job.id,
      status: options.willRetryOnFailure ? "queued" : "failed",
      progress: options.willRetryOnFailure ? 0 : 100,
      stage: options.willRetryOnFailure ? `retrying after worker error: ${message.slice(0, 180)}` : "failed",
      error: options.willRetryOnFailure ? undefined : message
    });
    if (!options.willRetryOnFailure) {
      await deliverJobWebhooks({
        userId: job.userId,
        jobId: job.id,
        status: "FAILED",
        payload: { error: message }
      });
    }
    throw error;
  }
}
