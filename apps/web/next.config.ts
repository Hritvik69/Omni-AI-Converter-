import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Monorepo keeps a single .env at the repo root; Next only loads apps/web by default.
const repoRoot = path.resolve(process.cwd(), "../..");
loadEnvConfig(repoRoot, process.env.NODE_ENV !== "production", console, true);

const nextConfig: NextConfig = {
  transpilePackages: ["@omniconvert/shared"],
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  experimental: {
    optimizePackageImports: ["lucide-react"]
  }
};

export default nextConfig;
