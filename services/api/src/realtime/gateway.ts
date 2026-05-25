import type { Server } from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "@clerk/backend";
import { env, isProduction } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { redisSub } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { REALTIME_CHANNEL } from "./events.js";

type ClientRecord = {
  userId: string;
  socket: WebSocket;
};

async function resolveUserIdFromToken(token?: string): Promise<string | null> {
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

export function attachRealtimeGateway(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<ClientRecord>();

  wss.on("connection", async (socket, request) => {
    try {
      const url = new URL(request.url ?? "/ws", "http://localhost");
      const token = url.searchParams.get("token") ?? undefined;
      const userId = await resolveUserIdFromToken(token);

      if (!userId) {
        socket.close(1008, "Unauthorized");
        return;
      }

      const record = { userId, socket };
      clients.add(record);
      socket.send(JSON.stringify({ type: "connected" }));

      socket.on("close", () => {
        clients.delete(record);
      });
    } catch (error) {
      logger.warn({ error }, "WebSocket authorization failed");
      socket.close(1008, "Unauthorized");
    }
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
