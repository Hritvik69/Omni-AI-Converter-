import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/errors.js";
import { requiredParam } from "../params.js";

export const apiKeysRouter = Router();

apiKeysRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.authUser.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        prefix: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true
      }
    });
    res.json({ keys });
  } catch (error) {
    next(error);
  }
});

apiKeysRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const input = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    const secret = `ocai_${nanoid(40)}`;
    const prefix = secret.slice(0, 12);
    const key = await prisma.apiKey.create({
      data: {
        userId: req.authUser.id,
        name: input.name,
        prefix,
        keyHash: crypto.createHash("sha256").update(secret).digest("hex")
      }
    });
    res.status(201).json({
      key: {
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        secret
      }
    });
  } catch (error) {
    next(error);
  }
});

apiKeysRouter.post("/:id/revoke", requireAuth, async (req, res, next) => {
  try {
    const id = requiredParam(req.params.id, "id");
    const result = await prisma.apiKey.updateMany({
      where: { id, userId: req.authUser.id, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    if (!result.count) throw new HttpError(404, "API key not found");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
