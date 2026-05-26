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
    const secret = crypto.randomBytes(32).toString("hex");
    const webhook = await prisma.webhookEndpoint.create({
      data: {
        userId: req.authUser.id,
        url: safeUrl,
        secret
      }
    });
    res.status(201).json({
      webhook: {
        id: webhook.id,
        url: webhook.url,
        status: webhook.status,
        secret
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
