FROM node:22-bookworm-slim AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    clamav \
    ffmpeg \
    libreoffice \
    pandoc \
    ghostscript \
    imagemagick \
    tesseract-ocr \
    poppler-utils \
    wkhtmltopdf \
    python3 \
    python3-pip \
    libvips42 \
    libheif1 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* tsconfig.base.json ./
COPY requirements.txt ./requirements.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt

COPY prisma ./prisma
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/shared/src ./packages/shared/src
COPY services/api/package.json ./services/api/package.json
COPY services/api/tsconfig.json ./services/api/tsconfig.json
COPY services/api/src ./services/api/src
COPY services/worker/package.json ./services/worker/package.json
COPY services/worker/tsconfig.json ./services/worker/tsconfig.json
COPY services/worker/src ./services/worker/src
COPY docker/start-fullstack.sh ./docker/start-fullstack.sh

RUN npm install
RUN npx prisma generate
RUN npm run build -w @omniconvert/shared \
  && npm run build -w @omniconvert/api \
  && npm run build -w @omniconvert/worker
RUN chmod +x /app/docker/start-fullstack.sh

EXPOSE 4000
CMD ["/app/docker/start-fullstack.sh"]
