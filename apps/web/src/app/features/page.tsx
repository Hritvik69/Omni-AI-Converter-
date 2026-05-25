const featureRows = [
  ["Image", "PNG, JPG, WEBP, SVG, GIF, BMP, TIFF, ICO, HEIC with compression, resizing, metadata stripping, and batch output."],
  ["Document", "PDF, DOCX, DOC, TXT, RTF, ODT, HTML, Markdown, EPUB through LibreOffice, Pandoc, PDF tooling, and Ghostscript."],
  ["Presentation", "PPTX, PPT, PDF slides, image exports, and PDF-to-PPTX decks via rendered slide images."],
  ["Media", "MP4, MOV, AVI, MKV, WEBM, GIF, FLV, MP3, WAV, AAC, FLAC, OGG, M4A through FFmpeg and FFprobe."],
  ["AI", "Tesseract OCR, OpenAI or Gemini document intelligence, Whisper transcription, subtitle generation, rembg, and Real-ESRGAN hooks."],
  ["Platform", "Chunk upload, WebSocket progress, BullMQ queues, Redis, S3, Prisma/Postgres, API keys, webhooks, presets, ZIP export."]
];

export default function FeaturesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
      <p className="text-xs font-bold uppercase tracking-[0.28em] text-neon-cyan">Capabilities</p>
      <h1 className="mt-2 text-4xl font-black text-white">Features</h1>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {featureRows.map(([title, text]) => (
          <section key={title} className="glass rounded-2xl p-5">
            <h2 className="text-lg font-black text-white">{title}</h2>
            <p className="mt-3 text-sm leading-7 text-slate-400">{text}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
