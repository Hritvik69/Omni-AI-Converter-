# OmniConvert AI

OmniConvert AI is a real full-stack universal file conversion platform: Next.js frontend, Express API, BullMQ worker fleet, Prisma/Postgres, Redis, S3-compatible object storage, WebSocket progress, Docker, and native conversion engines.

## Folder Structure

```text
apps/web                 Next.js 15 SaaS frontend
services/api             Express REST API, auth, uploads, validation, S3, WebSocket events
services/worker          BullMQ workers and real conversion engines
packages/shared          Shared validation schemas and TypeScript contracts
prisma/schema.prisma     PostgreSQL data model
docker/*.Dockerfile      Production container images
docs/DEPLOYMENT.md       Cloud deployment guide
render.yaml              One-click Render backend blueprint for demos
```

## Real Engines

- Images: Sharp and ImageMagick/libvips.
- Documents: LibreOffice headless, Pandoc, wkhtmltopdf/wkhtmltoimage, Ghostscript, PDF parsing.
- Presentations: LibreOffice, Poppler, PptxGenJS.
- Video and audio: FFmpeg and FFprobe.
- AI: Tesseract OCR, OpenAI/Gemini text models, Whisper transcription, rembg, optional Real-ESRGAN.

The old client-only converter has been removed. The browser now sends chunked uploads to the API; workers produce outputs server-side and store them in S3.

## Local Docker Run

```bash
cp .env.example .env
# Add Clerk test keys from https://dashboard.clerk.com (required for sign-in on localhost:3000)
docker compose up --build
```

Open `http://localhost:3000`. The API runs on `http://localhost:4000`, Postgres on `5432`, Redis on `6379`, and MinIO on `9000`/`9001`.

## Fast Live Demo Deploy

The easiest public demo is:

1. Deploy `apps/web` on Vercel.
2. Deploy the backend from `render.yaml` on Render. It runs the API and worker together in one Docker web service.
3. Render creates Postgres and Redis from the blueprint. The demo uses local container storage for converted files.
4. Add the backend URL to Vercel:

```text
NEXT_PUBLIC_API_URL=https://your-render-backend.onrender.com
```

For a no-login demo, `ALLOW_DEMO_AUTH=true` lets uploads and conversions run without Clerk. For real users, set `ALLOW_DEMO_AUTH=false`, add Clerk keys, and switch `STORAGE_DRIVER=s3` with Cloudflare R2 or another S3-compatible bucket.

## Local Node Run (no Docker app containers)

You still need **Postgres**, **Redis**, and **MinIO** on localhost (easiest via Docker infra only).

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
2. From the repo root:

```bash
npm install
python -m pip install -r requirements.txt
npm run db:generate
npm run dev:infra
npx prisma db push
npm run dev:local
```

`dev:infra` starts only Postgres, Redis, and MinIO. `dev:local` opens three terminals for the API, worker, and web app.

Install native binaries for conversions: FFmpeg, FFprobe, LibreOffice, Pandoc, wkhtmltopdf/wkhtmltoimage, Ghostscript, ImageMagick, Tesseract, Poppler, and `rembg` (see `requirements.txt`).

Set `WORKER_CONCURRENCY` higher on larger servers to process multiple queued outputs at once. The demo config uses `2` to keep ALL-format batches moving while staying modest for small hosts.

## Security

The API implements rate limits, Clerk/API-key auth, MIME validation, extension policy checks, optional ClamAV scanning, temporary upload directories, signed download URLs, and automatic asset expiry metadata. Run `npm run cleanup:expired -w @omniconvert/api` on a schedule to remove expired upload sessions, local/S3 objects, and database rows.
