import http from "node:http";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { apiRateLimit } from "./http/middleware/security.js";
import { errorHandler, notFoundHandler } from "./http/middleware/errors.js";
import { uploadsRouter } from "./http/routes/uploads.js";
import { conversionsRouter } from "./http/routes/conversions.js";
import { presetsRouter } from "./http/routes/presets.js";
import { webhooksRouter } from "./http/routes/webhooks.js";
import { apiKeysRouter } from "./http/routes/api-keys.js";
import { attachRealtimeGateway } from "./realtime/gateway.js";
import { logger } from "./lib/logger.js";

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);
app.use(
  cors({
    origin: env.WEB_ORIGIN.split(",").map((origin) => origin.trim()),
    credentials: true
  })
);
app.use(morgan("combined"));
app.use(apiRateLimit);
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "omniconvert-api",
    timestamp: new Date().toISOString()
  });
});

app.use("/api/uploads", uploadsRouter);
app.use("/api/conversions", conversionsRouter);
app.use("/api/presets", presetsRouter);
app.use("/api/webhooks", webhooksRouter);
app.use("/api/api-keys", apiKeysRouter);
app.use(notFoundHandler);
app.use(errorHandler);

attachRealtimeGateway(server);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "OmniConvert API listening");
});
