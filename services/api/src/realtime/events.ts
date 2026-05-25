import type { JobProgressEvent } from "@omniconvert/shared";
import { redisPub } from "../lib/redis.js";

export const REALTIME_CHANNEL = "omniconvert:job-events";

export async function publishJobEvent(userId: string, event: JobProgressEvent): Promise<void> {
  await redisPub.publish(REALTIME_CHANNEL, JSON.stringify({ userId, event }));
}
