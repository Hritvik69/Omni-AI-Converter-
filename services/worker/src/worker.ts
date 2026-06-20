import { Worker } from "bullmq";
import { env } from "./config/env.js";
import { redis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { cleanStaleTempDirs } from "./lib/temp.js";
import { processConversionJob } from "./jobs/process-conversion.js";

type ConversionQueueData = {
  conversionJobId: string;
};

// Fix 13: Clean stale temp dirs from previous crashed workers at startup,
// then repeat every 30 minutes to cap disk usage over long-running deployments.
const STALE_TEMP_MAX_AGE_MS = 1000 * 60 * 120; // 2 hours
void cleanStaleTempDirs(STALE_TEMP_MAX_AGE_MS).catch((error: unknown) => {
  logger.warn({ error }, "Startup stale temp dir cleanup failed");
});
setInterval(() => {
  void cleanStaleTempDirs(STALE_TEMP_MAX_AGE_MS).catch((error: unknown) => {
    logger.warn({ error }, "Periodic stale temp dir cleanup failed");
  });
}, 1000 * 60 * 30).unref();

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
    // Fix 3: Increased from 30min to 4 hours. Prevents BullMQ from releasing
    // the lock mid-conversion for large files, which would cause two workers
    // to concurrently process and complete the same job.
    lockDuration: 1000 * 60 * 60 * 4
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
