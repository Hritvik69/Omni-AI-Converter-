import crypto from "node:crypto";
import { resourceLimits } from "@omniconvert/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { validateOutboundWebhookUrl } from "../lib/url-safety.js";

async function readResponseBodyWithCap(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      bytesRead += value.byteLength;
      if (bytesRead > resourceLimits.webhookResponseBytes) {
        await reader.cancel();
        throw new Error("Webhook response body exceeded limit");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function markEndpointFailed(endpointId: string, reason: string): Promise<void> {
  await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: { status: "FAILED" }
  }).catch((error: unknown) => {
    logger.warn({ endpointId, reason, error }, "Failed to mark webhook endpoint as failed");
  });
}

export async function deliverJobWebhooks(args: {
  userId: string;
  jobId: string;
  status: "COMPLETED" | "FAILED";
  payload: Record<string, unknown>;
}): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { userId: args.userId, status: "ACTIVE" },
    take: resourceLimits.maxWebhookEndpointsPerUser,
    orderBy: { createdAt: "asc" }
  });

  await Promise.allSettled(
    endpoints.map(async (endpoint) => {
      const body = JSON.stringify({
        event: args.status === "COMPLETED" ? "conversion.completed" : "conversion.failed",
        jobId: args.jobId,
        createdAt: new Date().toISOString(),
        data: args.payload
      });
      const signature = crypto.createHmac("sha256", endpoint.secret).update(body).digest("hex");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), resourceLimits.webhookTimeoutMs);
      try {
        const url = await validateOutboundWebhookUrl(endpoint.url);
        const response = await fetch(url, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-omniconvert-signature": `sha256=${signature}`
          },
          body
        });
        await readResponseBodyWithCap(response);
        if (!response.ok) {
          logger.warn({ endpointId: endpoint.id, status: response.status }, "Webhook delivery failed");
          await markEndpointFailed(endpoint.id, `HTTP ${response.status}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown webhook error";
        logger.warn({ endpointId: endpoint.id, error: message }, "Webhook delivery failed");
        await markEndpointFailed(endpoint.id, message);
      } finally {
        clearTimeout(timeout);
      }
    })
  );
}
