import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Monorepo keeps a single .env at the repo root; Next only loads apps/web by default.
const repoRoot = path.resolve(process.cwd(), "../..");
loadEnvConfig(repoRoot, process.env.NODE_ENV !== "production", console, true);

const nextConfig: NextConfig = {
  transpilePackages: ["@omniconvert/shared"],
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  experimental: {
    optimizePackageImports: ["lucide-react"]
  }
};

export default nextConfig;
