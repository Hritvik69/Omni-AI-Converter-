import crypto from "node:crypto";
import type { Request, Response } from "express";
import { env, isProduction } from "../config/env.js";
import { prisma } from "./prisma.js";

export const demoSessionCookieName = "omniconvert_demo_session";

function demoSecret(): string {
  const secret = env.DEMO_SESSION_SECRET ?? env.CLERK_SECRET_KEY;
  if (secret) return secret;
  if (!isProduction) return "omniconvert-local-demo-session";
  throw new Error("DEMO_SESSION_SECRET or CLERK_SECRET_KEY is required for production demo auth");
}

function sign(sessionId: string): string {
  return crypto.createHmac("sha256", demoSecret()).update(sessionId).digest("base64url");
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const item of header?.split(";") ?? []) {
    const [name, ...rest] = item.trim().split("=");
    if (!name || !rest.length) continue;
    cookies[name] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

export function signedDemoSession(sessionId?: string): string {
  const id = sessionId ?? crypto.randomUUID();
  return `${id}.${sign(id)}`;
}

export function verifySignedDemoSession(value: string | undefined | null): string | null {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const sessionId = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) return null;
  return timingSafeEqual(signature, sign(sessionId)) ? sessionId : null;
}

export function readDemoSession(req: Pick<Request, "headers" | "header">): string | null {
  const fromHeader = verifySignedDemoSession(req.header?.("x-demo-session"));
  if (fromHeader) return fromHeader;
  const cookies = parseCookieHeader(req.headers.cookie);
  return verifySignedDemoSession(cookies[demoSessionCookieName]);
}

export function setDemoSessionCookie(res: Response, signedValue: string): void {
  const secure = isProduction;
  res.cookie(demoSessionCookieName, signedValue, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7,
    path: "/"
  });
}

export async function upsertDemoUser(sessionId: string) {
  const clerkId = isProduction ? `demo-user:${sessionId}` : "dev-user";
  return prisma.user.upsert({
    where: { clerkId },
    create: {
      clerkId,
      email: isProduction ? null : "dev@omniconvert.local",
      name: isProduction ? "Live Demo" : "Local Developer"
    },
    update: {}
  });
}
