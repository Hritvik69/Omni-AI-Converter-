import Link from "next/link";
import { ArrowRight, CheckCircle2, Gauge, Layers3, ShieldCheck } from "lucide-react";
import { FormatConstellation } from "../components/FormatConstellation";

const highlights = [
  { icon: Layers3, label: "34 formats", text: "Images, docs, slides, video, and audio in one pipeline." },
  { icon: Gauge, label: "Queue-backed", text: "Uploads, progress, retries, and workers stay connected." },
  { icon: ShieldCheck, label: "Secure path", text: "MIME checks, isolated temp folders, and signed downloads." }
];

export default function HomePage() {
  return (
    <div className="mx-auto max-w-7xl px-4 pb-14 pt-8 sm:px-6 lg:px-8">
      <section className="relative">
        <div className="mx-auto max-w-4xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.045] px-4 py-2 text-xs font-black uppercase tracking-[0.22em] text-neon-cyan">
            <CheckCircle2 size={14} />
            Production file intelligence
          </div>
          <h1 className="mx-auto mt-5 max-w-4xl text-5xl font-black tracking-tight text-white sm:text-6xl">
            OmniConvert AI
          </h1>
          <p className="mx-auto mt-5 max-w-3xl text-lg leading-8 text-slate-300">
            Universal file conversion with real backend processing engines, streamed uploads, queue workers, signed object storage, and AI document tooling.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link href="/dashboard" className="focus-ring inline-flex items-center gap-2 rounded-full bg-neon-cyan px-6 py-3 text-sm font-black text-ink shadow-glow transition hover:bg-white">
              Open Dashboard
              <ArrowRight size={16} />
            </Link>
            <a href="#format-map" className="focus-ring inline-flex items-center gap-2 rounded-full border border-line px-6 py-3 text-sm font-black text-white transition hover:border-neon-cyan hover:bg-white/[0.04]">
              Explore Formats
            </a>
          </div>
        </div>

        <div className="mt-8">
          <FormatConstellation />
        </div>
      </section>

      <section className="grid gap-3 pt-8 md:grid-cols-3">
        {highlights.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="rounded-lg border border-white/10 bg-white/[0.045] p-5">
              <div className="flex items-center gap-3">
                <Icon size={18} className="text-neon-cyan" />
                <h2 className="text-sm font-black uppercase tracking-[0.16em] text-white">{item.label}</h2>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-400">{item.text}</p>
            </div>
          );
        })}
      </section>
    </div>
  );
}
