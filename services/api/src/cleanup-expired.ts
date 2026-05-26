import { cleanupExpiredData } from "./jobs/cleanup-expired.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";

try {
  const result = await cleanupExpiredData();
  logger.info(result, "Expired upload and asset cleanup complete");
} finally {
  await prisma.$disconnect();
}
