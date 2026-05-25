import { Worker } from "bullmq";
import { env } from "./config/env.js";
import { redis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { processConversionJob } from "./jobs/process-conversion.js";

type ConversionQueueData = {
  conversionJobId: string;
};

const worker = new Worker<ConversionQueueData>(
  "conversion",
  async (job) => {
    logger.info({ queueJobId: job.id, conversionJobId: job.data.conversionJobId, name: job.name }, "Processing job");
    const maxAttempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
    await processConversionJob(job.data.conversionJobId, {
      willRetryOnFailure: job.attemptsMade + 1 < maxAttempts
    });
  },
  {
    connection: redis,
    concurrency: env.WORKER_CONCURRENCY,
    lockDuration: 1000 * 60 * 30
  }
);

worker.on("completed", (job) => {
  logger.info({ queueJobId: job.id, conversionJobId: job.data.conversionJobId }, "Job completed");
});

worker.on("failed", (job, error) => {
  logger.error(
    { queueJobId: job?.id, conversionJobId: job?.data.conversionJobId, error },
    "Job failed"
  );
});

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received; closing worker");
  await worker.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received; closing worker");
  await worker.close();
  process.exit(0);
});

logger.info({ concurrency: env.WORKER_CONCURRENCY }, "OmniConvert worker online");
