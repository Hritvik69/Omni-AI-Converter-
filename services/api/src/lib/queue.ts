import { Queue } from "bullmq";
import { redis } from "./redis.js";

export type ConversionQueueData = {
  conversionJobId: string;
};

export const conversionQueue = new Queue<ConversionQueueData>("conversion", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000
    },
    removeOnComplete: {
      age: 60 * 60 * 24,
      count: 5000
    },
    removeOnFail: {
      age: 60 * 60 * 24 * 7
    }
  }
});
