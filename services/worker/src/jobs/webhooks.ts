import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export async function deliverJobWebhooks(args: {
  userId: string;
  jobId: string;
  status: "COMPLETED" | "FAILED";
  payload: Record<string, unknown>;
}): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { userId: args.userId, status: "ACTIVE" }
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
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omniconvert-signature": `sha256=${signature}`
        },
        body
      });
      if (!response.ok) {
        logger.warn({ endpointId: endpoint.id, status: response.status }, "Webhook delivery failed");
      }
    })
  );
}
