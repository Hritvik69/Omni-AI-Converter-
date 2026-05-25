import type { JobProgressEvent } from "@omniconvert/shared";
import { redisPub } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";

const REALTIME_CHANNEL = "omniconvert:job-events";

export async function updateJobProgress(args: {
  userId: string;
  jobId: string;
  status: JobProgressEvent["status"];
  progress: number;
  stage: string;
  outputAssetId?: string;
  error?: string;
}): Promise<void> {
  await prisma.conversionJob.update({
    where: { id: args.jobId },
    data: {
      status:
        args.status === "queued"
          ? "QUEUED"
          : args.status === "running"
            ? "RUNNING"
            : args.status === "completed"
              ? "COMPLETED"
              : "FAILED",
      progress: Math.max(0, Math.min(100, Math.round(args.progress))),
      stage: args.stage,
      error: args.error,
      outputAssetId: args.outputAssetId,
      startedAt: args.status === "running" ? new Date() : undefined,
      completedAt: args.status === "completed" || args.status === "failed" ? new Date() : undefined
    }
  });

  await redisPub.publish(
    REALTIME_CHANNEL,
    JSON.stringify({
      userId: args.userId,
      event: {
        jobId: args.jobId,
        status: args.status,
        progress: Math.max(0, Math.min(100, Math.round(args.progress))),
        stage: args.stage,
        outputAssetId: args.outputAssetId,
        error: args.error
      }
    })
  );
}
