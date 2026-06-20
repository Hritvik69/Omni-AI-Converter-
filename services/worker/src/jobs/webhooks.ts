import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { resourceLimits } from "@omniconvert/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { isBlockedIpAddress, validateOutboundWebhookUrl } from "../lib/url-safety.js";

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

/**
 * Fix 6: DNS-pinned fetch for webhook delivery.
 *
 * Resolves the hostname to an IP at delivery time, validates it against the
 * blocklist, then connects to that specific IP (setting Host header to the
 * original hostname). This prevents DNS re-binding attacks where a hostname
 * resolves to a public IP at registration time but to a private IP at delivery.
 */
async function fetchWithDnsPinning(
  rawUrl: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  const parsed = new URL(rawUrl);
  const hostname = parsed.hostname;

  // If the hostname is already an IP literal, validate directly
  if (net.isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error(`Webhook delivery blocked: ${hostname} is a private/reserved address`);
    }
    return fetch(rawUrl, { ...init, signal });
  }

  // Re-resolve DNS at delivery time (prevents TTL-0 re-binding)
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error(`Webhook host did not resolve: ${hostname}`);

  // Validate every resolved IP — use the first non-blocked one
  const safeRecord = records.find((r) => !isBlockedIpAddress(r.address));
  if (!safeRecord) {
    throw new Error(`Webhook delivery blocked: ${hostname} resolves to a private/reserved network`);
  }

  // Connect directly to the resolved IP to prevent TOCTOU re-resolution
  const targetIp = safeRecord.address;
  const isIPv6 = net.isIPv6(targetIp);
  const ipLiteral = isIPv6 ? `[${targetIp}]` : targetIp;
  const pinned = new URL(rawUrl);
  pinned.hostname = ipLiteral;

  return fetch(pinned.toString(), {
    ...init,
    signal,
    headers: {
      ...((init.headers as Record<string, string>) ?? {}),
      // Preserve original Host header for the receiving server
      Host: parsed.port ? `${hostname}:${parsed.port}` : hostname
    }
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
        // Validate URL syntax and protocol at delivery time
        const url = await validateOutboundWebhookUrl(endpoint.url);
        // Fix 6: Use DNS-pinned fetch to prevent re-binding after validation
        const response = await fetchWithDnsPinning(
          url,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              "x-omniconvert-signature": `sha256=${signature}`
            },
            body
          },
          controller.signal
        );
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
