"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import clsx from "clsx";
import { ArrowRight, FileImage, FileText, FileVideo, Music2, Presentation, Sparkles, UploadCloud } from "lucide-react";

type CategoryId = "image" | "document" | "presentation" | "video" | "audio";

type FormatCategory = {
  id: CategoryId;
  label: string;
  eyebrow: string;
  accent: string;
  soft: string;
  icon: typeof FileImage;
  description: string;
  formats: string[];
};

const categories: FormatCategory[] = [
  {
    id: "image",
    label: "Image",
    eyebrow: "Photos and graphics",
    accent: "#38bdf8",
    soft: "rgba(56, 189, 248, 0.13)",
    icon: FileImage,
    description: "Clean image conversion for previews, web assets, mobile photos, and archive files.",
    formats: ["PNG", "JPG", "JPEG", "WEBP", "SVG", "GIF", "BMP", "TIFF", "ICO", "HEIC"]
  },
  {
    id: "document",
    label: "Document",
    eyebrow: "PDF and office files",
    accent: "#f59e0b",
    soft: "rgba(245, 158, 11, 0.13)",
    icon: FileText,
    description: "Readable document output for sharing, editing, extraction, and AI processing.",
    formats: ["PDF", "DOCX", "DOC", "TXT", "RTF", "ODT", "HTML", "MD", "MARKDOWN", "EPUB"]
  },
  {
    id: "presentation",
    label: "Slides",
    eyebrow: "Decks and exports",
    accent: "#f472b6",
    soft: "rgba(244, 114, 182, 0.13)",
    icon: Presentation,
    description: "Presentation conversion for editable decks, review PDFs, and slide previews.",
    formats: ["PPTX", "PPT", "PDF", "PNG", "JPG"]
  },
  {
    id: "video",
    label: "Video",
    eyebrow: "Clips and media",
    accent: "#a78bfa",
    soft: "rgba(167, 139, 250, 0.13)",
    icon: FileVideo,
    description: "Video pipelines for playback, compression, extraction, and modern web delivery.",
    formats: ["MP4", "MOV", "AVI", "MKV", "WEBM", "GIF", "FLV"]
  },
  {
    id: "audio",
    label: "Audio",
    eyebrow: "Sound and speech",
    accent: "#2dd4bf",
    soft: "rgba(45, 212, 191, 0.13)",
    icon: Music2,
    description: "Audio output for listening copies, transcription, editing, and lossless storage.",
    formats: ["MP3", "WAV", "AAC", "FLAC", "OGG", "M4A"]
  }
];

const totalFormats = new Set(categories.flatMap((category) => category.formats)).size;

export function FormatConstellation() {
  const [activeId, setActiveId] = useState<CategoryId>("document");
  const active = categories.find((category) => category.id === activeId) ?? categories.find((category) => category.id === "document")!;
  const ActiveIcon = active.icon;

  return (
    <div className="mx-auto w-full max-w-6xl" id="format-map">
      <div className="simple-map overflow-hidden rounded-lg border border-white/10 bg-[#070b14]/92">
        <div className="grid gap-0 lg:grid-cols-[0.8fr_1.1fr_0.9fr]">
          <div className="simple-map-panel border-b border-white/10 p-5 lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan">
                <UploadCloud size={20} />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">Step 1</p>
                <h3 className="text-lg font-black text-white">Drop a File</h3>
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-400">
              Start with any supported file. The app detects its type and sends it to the right worker.
            </p>
            <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.045] p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-neon-cyan">Supported</p>
              <p className="mt-2 text-3xl font-black text-white">{totalFormats}</p>
              <p className="text-sm text-slate-400">formats across 5 clear groups</p>
            </div>
          </div>

          <div className="simple-map-panel p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-neon-cyan">Step 2</p>
                <h3 className="text-xl font-black text-white">Choose a Type</h3>
              </div>
              <ArrowRight size={20} className="hidden text-slate-500 sm:block" />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {categories.map((category) => {
                const Icon = category.icon;
                const selected = category.id === active.id;
                return (
                  <button
                    type="button"
                    key={category.id}
                    onClick={() => setActiveId(category.id)}
                    className={clsx(
                      "focus-ring group rounded-lg border p-4 text-left transition",
                      selected
                        ? "border-white/24 bg-white/[0.075] shadow-glow"
                        : "border-white/10 bg-white/[0.035] hover:border-white/24 hover:bg-white/[0.06]"
                    )}
                    style={
                      {
                        "--category-accent": category.accent
                      } as CSSProperties
                    }
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="flex h-10 w-10 items-center justify-center rounded-lg border"
                        style={{ borderColor: category.accent, background: category.soft, color: category.accent }}
                      >
                        <Icon size={18} />
                      </span>
                      <span>
                        <span className="block text-sm font-black text-white">{category.label}</span>
                        <span className="mt-1 block text-xs font-bold text-slate-500">{category.eyebrow}</span>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="simple-map-panel border-t border-white/10 p-5 lg:border-l lg:border-t-0">
            <div className="flex items-center gap-3">
              <div
                className="flex h-11 w-11 items-center justify-center rounded-lg border"
                style={{ borderColor: active.accent, background: active.soft, color: active.accent }}
              >
                <ActiveIcon size={20} />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">Step 3</p>
                <h3 className="text-lg font-black text-white">{active.label} Output</h3>
              </div>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-400">{active.description}</p>

            <div className="mt-5 flex flex-wrap gap-2">
              {active.formats.map((format) => (
                <span
                  key={`${active.id}-${format}`}
                  className="rounded-full border px-3 py-2 text-xs font-black text-white"
                  style={{ borderColor: active.accent, background: active.soft }}
                >
                  {format}
                </span>
              ))}
            </div>

            <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.045] p-4">
              <div className="flex items-center gap-2 text-neon-cyan">
                <Sparkles size={16} />
                <p className="text-[10px] font-black uppercase tracking-[0.22em]">AI-ready</p>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                OCR, summaries, subtitles, repair, and clean previews sit behind the same conversion flow.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
