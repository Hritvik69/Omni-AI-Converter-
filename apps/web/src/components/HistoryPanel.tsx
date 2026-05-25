"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Download, Loader2 } from "lucide-react";
import { apiFetch } from "../lib/api";

type HistoryResponse = {
  jobs: Array<{
    id: string;
    status: string;
    progress: number;
    sourceFormat: string;
    targetFormat: string;
    createdAt: string;
    completedAt?: string | null;
    input: { name: string; sizeBytes: number };
    output?: { name: string; downloadUrl: string; sizeBytes: number } | null;
  }>;
};

export function HistoryPanel() {
  const { getToken } = useAuth();
  const [jobs, setJobs] = useState<HistoryResponse["jobs"]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<HistoryResponse>("/api/conversions/history", {}, getToken)
      .then((result) => setJobs(result.jobs))
      .finally(() => setLoading(false));
  }, [getToken]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
      <p className="text-xs font-bold uppercase tracking-[0.28em] text-neon-cyan">Account</p>
      <h1 className="mt-2 text-4xl font-black text-white">User History</h1>
      <div className="mt-8 overflow-hidden rounded-2xl border border-line">
        {loading ? (
          <div className="flex items-center justify-center gap-3 p-10 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin text-neon-cyan" />
            Loading history
          </div>
        ) : jobs.length ? (
          jobs.map((job) => (
            <div key={job.id} className="grid gap-3 border-b border-line bg-white/[0.03] p-4 text-sm last:border-b-0 md:grid-cols-[1.4fr_0.6fr_0.7fr_80px]">
              <div>
                <div className="font-bold text-white">{job.input.name}</div>
                <div className="mt-1 text-xs text-slate-500">{new Date(job.createdAt).toLocaleString()}</div>
              </div>
              <div className="font-black text-neon-cyan">{job.sourceFormat.toUpperCase()} → {job.targetFormat.toUpperCase()}</div>
              <div className="text-slate-300">{job.status}</div>
              <div className="text-right">
                {job.output?.downloadUrl ? (
                  <a href={job.output.downloadUrl} className="inline-flex rounded-lg bg-white px-3 py-2 text-ink">
                    <Download size={15} />
                  </a>
                ) : null}
              </div>
            </div>
          ))
        ) : (
          <div className="p-10 text-center text-sm text-slate-500">No history yet.</div>
        )}
      </div>
    </div>
  );
}
