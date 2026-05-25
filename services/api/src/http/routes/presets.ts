import { Router } from "express";
import { z } from "zod";
import { conversionOptionsSchema } from "@omniconvert/shared";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/errors.js";
import { requiredParam } from "../params.js";

export const presetsRouter = Router();

const presetSchema = z.object({
  name: z.string().min(1).max(80),
  target: z.string().min(1).max(20),
  options: conversionOptionsSchema.default({})
});

presetsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const presets = await prisma.conversionPreset.findMany({
      where: { userId: req.authUser.id },
      orderBy: { createdAt: "desc" }
    });
    res.json({ presets });
  } catch (error) {
    next(error);
  }
});

presetsRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const input = presetSchema.parse(req.body);
    const preset = await prisma.conversionPreset.create({
      data: {
        userId: req.authUser.id,
        name: input.name,
        target: input.target.toLowerCase(),
        options: input.options
      }
    });
    res.status(201).json({ preset });
  } catch (error) {
    next(error);
  }
});

presetsRouter.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = requiredParam(req.params.id, "id");
    const deleted = await prisma.conversionPreset.deleteMany({
      where: { id, userId: req.authUser.id }
    });
    if (!deleted.count) throw new HttpError(404, "Preset not found");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
