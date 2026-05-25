FROM node:22-bookworm-slim AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates clamav \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* tsconfig.base.json ./
COPY prisma ./prisma
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/shared/src ./packages/shared/src
COPY services/api/package.json ./services/api/package.json
COPY services/api/tsconfig.json ./services/api/tsconfig.json
COPY services/api/src ./services/api/src

RUN npm install --include=dev
RUN npx prisma generate
RUN npm run build -w @omniconvert/shared && npm run build -w @omniconvert/api

EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node services/api/dist/server.js"]
