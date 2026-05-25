import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "@clerk/backend";
import { env, isProduction } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "./errors.js";

declare global {
  namespace Express {
    interface Request {
      authUser: {
        id: string;
        clerkId: string;
        email?: string | null;
      };
    }
  }
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const apiKey = req.header("x-api-key");
    if (apiKey) {
      const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
      const record = await prisma.apiKey.findFirst({
        where: { keyHash, revokedAt: null },
        include: { user: true }
      });
      if (!record) throw new HttpError(401, "Invalid API key");
      await prisma.apiKey.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() }
      });
      req.authUser = {
        id: record.user.id,
        clerkId: record.user.clerkId,
        email: record.user.email
      };
      return next();
    }

    const token = extractBearerToken(req);

    if (!token && !isProduction) {
      const user = await prisma.user.upsert({
        where: { clerkId: "dev-user" },
        create: {
          clerkId: "dev-user",
          email: "dev@omniconvert.local",
          name: "Local Developer"
        },
        update: {}
      });
      req.authUser = { id: user.id, clerkId: user.clerkId, email: user.email };
      return next();
    }

    if (!token) throw new HttpError(401, "Missing bearer token");
    if (!env.CLERK_SECRET_KEY) throw new HttpError(500, "CLERK_SECRET_KEY is not configured");

    const verified = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY
    });

    const clerkId = verified.sub;
    if (!clerkId) throw new HttpError(401, "Invalid token subject");

    const claims = verified as Record<string, unknown>;
    const email =
      typeof claims.email === "string"
        ? claims.email
        : typeof claims.primary_email_address === "string"
          ? claims.primary_email_address
          : null;

    const user = await prisma.user.upsert({
      where: { clerkId },
      create: { clerkId, email },
      update: { email }
    });

    req.authUser = { id: user.id, clerkId: user.clerkId, email: user.email };
    return next();
  } catch (error) {
    return next(error);
  }
}
