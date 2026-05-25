-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('ORIGINAL', 'OUTPUT', 'THUMBNAIL', 'SUBTITLE', 'ARCHIVE');

-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('S3', 'LOCAL');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('CONVERSION', 'AI');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('ACTIVE', 'PAUSED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL DEFAULT 'ORIGINAL',
    "storage" "StorageProvider" NOT NULL DEFAULT 'S3',
    "bucket" TEXT,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "checksumSha256" TEXT,
    "etag" TEXT,
    "metadata" JSONB,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversionJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL DEFAULT 'CONVERSION',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "queueJobId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sourceFormat" TEXT NOT NULL,
    "targetFormat" TEXT NOT NULL,
    "tool" TEXT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "inputAssetId" TEXT NOT NULL,
    "outputAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ConversionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversionPreset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversionPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkId_key" ON "User"("clerkId");

-- CreateIndex
CREATE INDEX "FileAsset_userId_createdAt_idx" ON "FileAsset"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FileAsset_storageKey_idx" ON "FileAsset"("storageKey");

-- CreateIndex
CREATE INDEX "ConversionJob_userId_createdAt_idx" ON "ConversionJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversionJob_status_createdAt_idx" ON "ConversionJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ConversionJob_queueJobId_idx" ON "ConversionJob"("queueJobId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversionPreset_userId_name_key" ON "ConversionPreset"("userId", "name");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_userId_status_idx" ON "WebhookEndpoint"("userId", "status");

-- CreateIndex
CREATE INDEX "ApiKey_userId_revokedAt_idx" ON "ApiKey"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionJob" ADD CONSTRAINT "ConversionJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionJob" ADD CONSTRAINT "ConversionJob_inputAssetId_fkey" FOREIGN KEY ("inputAssetId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionJob" ADD CONSTRAINT "ConversionJob_outputAssetId_fkey" FOREIGN KEY ("outputAssetId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionPreset" ADD CONSTRAINT "ConversionPreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
