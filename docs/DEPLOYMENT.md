# OmniConvert AI Deployment

## Services

Deploy the platform as three independently scalable services:

- `web`: Next.js 15 on Vercel or a Node container.
- `api`: Express REST/WebSocket API on Railway, Render, ECS, Fly, or Kubernetes.
- `worker`: CPU-heavy conversion workers on containers with native binaries installed.

Postgres, Redis, and S3 must be managed services in production. Use CloudFront or another CDN in front of signed S3 downloads when traffic grows.

## Required Environment

Set every variable in `.env.example`. Production must provide:

- `DATABASE_URL`
- `REDIS_URL`
- `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `OPENAI_API_KEY` or `GEMINI_API_KEY` for AI text features

Optional AI engines:

- `REALESRGAN_BIN` for actual AI upscaling.
- `REMBG_BIN` for background removal.

## Native Engine Layer

Workers need:

- `ffmpeg`, `ffprobe`
- `soffice` from LibreOffice
- `pandoc`
- `gs` from Ghostscript
- `magick` from ImageMagick
- `tesseract`
- `pdftoppm` from Poppler
- `wkhtmltopdf` for Pandoc PDF output

The worker Dockerfile installs these. For Linux workers, `.key` Keynote files are not directly supported by Apple tooling. Support Keynote by requiring users to export `.key` to `.pptx` or `.pdf`, or run a separate macOS worker pool that automates Keynote export and feeds the resulting PPTX/PDF back into the same queue.

## Scaling

Increase API replicas for upload/API traffic. Increase worker replicas for conversion throughput. BullMQ coordinates distributed workers through Redis. Use separate worker queues by media class if you want finer CPU/GPU scheduling:

- image/document queue: CPU and memory optimized
- video/audio queue: CPU optimized with high ephemeral disk
- AI queue: GPU or provider API budget optimized

## Storage Lifecycle

Uploads and outputs are stored with 7-day expiry metadata. Configure S3 lifecycle rules to delete:

- `users/*/originals/*` after 7 days
- `users/*/outputs/*` after plan-specific retention
- incomplete multipart uploads after 1 day

## Deployment Steps

1. Provision Postgres, Redis, and S3.
2. Set environment variables.
3. Run `npm install && npm run db:generate`.
4. Apply schema with `npx prisma migrate deploy` in production, or `npx prisma db push` for first local/dev boot.
5. Deploy `api` and `worker` containers.
6. Deploy `web` with `NEXT_PUBLIC_API_URL` pointing at the API.
7. Configure Clerk allowed origins and redirect URLs.
8. Configure CDN and S3 lifecycle policies.
9. Run a smoke conversion for each engine family.

## Smoke Tests

- PNG to WEBP
- DOCX to PDF
- Markdown to DOCX
- PPTX to PDF
- MP4 to WEBM
- WAV to MP3
- Image OCR to TXT
- Audio to transcript

Failures usually mean the worker image is missing a native binary, a provider API key, or an S3 permission.
