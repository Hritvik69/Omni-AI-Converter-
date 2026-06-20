import http from "node:http";
import { spawn } from "node:child_process";
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

// Fix 8: ClamAV startup health check.
// Verifies the scanner binary is present and logs its version/DB date at startup.
// If CLAMAV_REQUIRED=true and the binary is missing, the process throws.
type ClamavStatus = "ok" | "missing";
let clamavStatus: ClamavStatus = "missing";

function checkClamav(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(env.CLAMSCAN_BIN, ["--version"], { windowsHide: true });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (env.CLAMAV_REQUIRED) {
        logger.error({ error, bin: env.CLAMSCAN_BIN }, "ClamAV binary not found — aborting startup (CLAMAV_REQUIRED=true)");
        throw new Error(`ClamAV binary not found: ${error.message}`);
      }
      logger.error({ error, bin: env.CLAMSCAN_BIN }, "ClamAV binary not found — continuing because CLAMAV_REQUIRED=false");
      clamavStatus = "missing";
      resolve();
    });
    child.on("close", (code) => {
      if (code === 0) {
        clamavStatus = "ok";
        logger.info({ version: stdout.trim() }, "ClamAV ready");
      } else {
        if (env.CLAMAV_REQUIRED) {
          throw new Error(`ClamAV version check failed with exit code ${code}`);
        }
        logger.error({ code }, "ClamAV version check failed — continuing because CLAMAV_REQUIRED=false");
        clamavStatus = "missing";
      }
      resolve();
    });
  });
}

// Run the check at startup (non-blocking — server still starts, but status is logged)
void checkClamav();

const app = express();
const server = http.createServer(app);
const allowedOrigins = env.WEB_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);

// Fix 9: Use a configurable trusted proxy CIDR instead of blindly trusting 1 hop.
// When TRUSTED_PROXY_CIDR is not set we fall back to "loopback" (trusts only
// 127.0.0.1 / ::1), which is correct when the server is run without a proxy.
// In production behind a load balancer, set TRUSTED_PROXY_CIDR to the LB's IP range.
app.set("trust proxy", process.env.TRUSTED_PROXY_CIDR || "loopback");

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: true,
    exposedHeaders: ["X-Demo-Session"]
  })
);
app.use(morgan("combined"));
app.use(apiRateLimit);
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "omniconvert-api",
    message: "OmniConvert API is running. Use /health for status and /api/* for API routes.",
    routes: {
      health: "/health",
      uploads: "/api/uploads",
      conversions: "/api/conversions",
      presets: "/api/presets",
      webhooks: "/api/webhooks",
      apiKeys: "/api/api-keys"
    }
  });
});

// Fix 8: /health now includes ClamAV scanner status for monitoring systems
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "omniconvert-api",
    timestamp: new Date().toISOString(),
    clamav: clamavStatus
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
