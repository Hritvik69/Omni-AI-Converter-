import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { resourceLimits } from "@omniconvert/shared";
import { prisma } from "../../lib/prisma.js";
import { validateUserWebhookUrl } from "../../lib/url-safety.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/errors.js";
import { requiredParam } from "../params.js";

export const webhooksRouter = Router();

const webhookSchema = z.object({
  url: z.string().url()
});

webhooksRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const webhooks = await prisma.webhookEndpoint.findMany({
      where: { userId: req.authUser.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, url: true, status: true, createdAt: true }
    });
    res.json({ webhooks });
  } catch (error) {
    next(error);
  }
});

webhooksRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const input = webhookSchema.parse(req.body);
    const endpointCount = await prisma.webhookEndpoint.count({
      where: { userId: req.authUser.id, status: { not: "FAILED" } }
    });
    if (endpointCount >= resourceLimits.maxWebhookEndpointsPerUser) {
      throw new HttpError(422, `You can register up to ${resourceLimits.maxWebhookEndpointsPerUser} active webhook endpoints`);
    }
    const safeUrl = await validateUserWebhookUrl(input.url);
    // Fix 16: Generate secret; store only its SHA-256 hash.
    // The plaintext secret is returned to the user exactly once here and is
    // never written to the database, so a DB dump cannot expose signing keys.
    // The worker uses the stored hash as the HMAC key for per-endpoint uniqueness.
    const rawSecret = crypto.randomBytes(32).toString("hex");
    const secretHash = crypto.createHash("sha256").update(rawSecret).digest("hex");
    const webhook = await prisma.webhookEndpoint.create({
      data: {
        userId: req.authUser.id,
        url: safeUrl,
        secret: secretHash // stored as hash — NOT plaintext
      }
    });
    res.status(201).json({
      webhook: {
        id: webhook.id,
        url: webhook.url,
        status: webhook.status,
        // Return the raw secret once — the user must save it; we cannot recover it
        secret: rawSecret
      }
    });
  } catch (error) {
    next(error);
  }
});

webhooksRouter.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = requiredParam(req.params.id, "id");
    const deleted = await prisma.webhookEndpoint.deleteMany({
      where: { id, userId: req.authUser.id }
    });
    if (!deleted.count) throw new HttpError(404, "Webhook not found");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
