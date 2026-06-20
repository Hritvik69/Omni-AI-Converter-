import type { Server } from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "@clerk/backend";
import { env, isProduction } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { redisSub } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { demoSessionCookieName, parseCookieHeader, signedDemoSession, upsertDemoUser, verifySignedDemoSession } from "../lib/demo-auth.js";
import { REALTIME_CHANNEL } from "./events.js";

type ClientRecord = {
  userId: string;
  socket: WebSocket;
};

async function resolveUserIdFromToken(token?: string, cookieHeader?: string, demoSession?: string): Promise<string | null> {
  if (!token && (!isProduction || env.ALLOW_DEMO_AUTH)) {
    const cookies = parseCookieHeader(cookieHeader);
    const generatedSession = signedDemoSession();
    const sessionId =
      verifySignedDemoSession(demoSession) ??
      verifySignedDemoSession(cookies[demoSessionCookieName]) ??
      generatedSession.slice(0, generatedSession.lastIndexOf("."));
    const user = await upsertDemoUser(sessionId);
    return user.id;
  }

  if (!token || !env.CLERK_SECRET_KEY) return null;
  const verified = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
  if (!verified.sub) return null;
  const user = await prisma.user.upsert({
    where: { clerkId: verified.sub },
    create: { clerkId: verified.sub },
    update: {}
  });
  return user.id;
}

const AUTH_HANDSHAKE_TIMEOUT_MS = 5000;

export function attachRealtimeGateway(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<ClientRecord>();

  wss.on("connection", (socket, request) => {
    // Parse demoSession from URL — it is not a secret credential
    const url = new URL(request.url ?? "/ws", "http://localhost");
    const demoSession = url.searchParams.get("demoSession") ?? undefined;
    const cookieHeader = request.headers.cookie;

    // NOTE: token is intentionally NOT read from URL params (Fix 1).
    // Authentication is performed via a post-connection JSON frame.
    let authenticated = false;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        socket.close(1008, "Unauthorized");
      }
    }, AUTH_HANDSHAKE_TIMEOUT_MS);

    socket.on("message", (raw) => {
      // Only process the auth frame; ignore all other messages before auth
      if (authenticated) return;

      let frame: unknown;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (
        typeof frame !== "object" ||
        frame === null ||
        (frame as Record<string, unknown>)["type"] !== "auth"
      ) {
        return;
      }

      const token = (frame as Record<string, unknown>)["token"];
      const authToken = typeof token === "string" ? token : undefined;

      // Resolve userId asynchronously; close on failure
      resolveUserIdFromToken(authToken, cookieHeader, demoSession)
        .then((userId) => {
          clearTimeout(authTimeout);
          if (!userId) {
            socket.close(1008, "Unauthorized");
            return;
          }
          authenticated = true;
          const record: ClientRecord = { userId, socket };
          clients.add(record);
          socket.send(JSON.stringify({ type: "connected" }));
          socket.on("close", () => {
            clients.delete(record);
          });
        })
        .catch((error: unknown) => {
          clearTimeout(authTimeout);
          logger.warn({ error }, "WebSocket authorization failed");
          socket.close(1008, "Unauthorized");
        });
    });

    socket.on("close", () => {
      // If the socket closes before auth completes, clear the timeout
      clearTimeout(authTimeout);
    });

    socket.on("error", () => {
      clearTimeout(authTimeout);
      socket.close(1008, "Unauthorized");
    });
  });

  redisSub.subscribe(REALTIME_CHANNEL).catch((error: unknown) => {
    logger.error({ error }, "Failed to subscribe to realtime channel");
  });

  redisSub.on("message", (_channel: string, raw: string) => {
    try {
      const message = JSON.parse(raw) as { userId: string; event: unknown };
      const payload = JSON.stringify({ type: "job.progress", event: message.event });
      for (const client of clients) {
        if (client.userId === message.userId && client.socket.readyState === WebSocket.OPEN) {
          client.socket.send(payload);
        }
      }
    } catch (error) {
      logger.warn({ error }, "Failed to dispatch realtime message");
    }
  });
}
