"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { motion } from "framer-motion";
import {
  Archive,
  CheckCircle2,
  CloudUpload,
  Download,
  FileText,
  ImageIcon,
  Loader2,
  Play,
  QrCode,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  Video
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  API_NOT_CONFIGURED_MESSAGE,
  API_URL,
  apiFetch,
  authHeaders,
  getDemoSession,
  getOptionalAuthToken,
  isApiConfigured,
  warmAuthSession,
  websocketUrl
} from "../lib/api";
import { allTargets, defaultTargets, extensionOf } from "../lib/formats";
import { uploadFileInChunks } from "../lib/upload";

type UploadRow = {
  id: string;
  name: string;
  size: number;
  extension: string;
  targetFormat: string;
  status: "ready" | "uploading" | "queued" | "running" | "completed" | "failed";
  progress: number;
  stage: string;
  uploadId?: string;
  jobId?: string;
  outputAssetId?: string;
  downloadUrl?: string;
  error?: string;
};

type ConversionResponse = {
  jobs: Array<{ id: string; status: string; progress: number; targetFormat: string }>;
};

type JobStateResponse = {
  job: {
    id: string;
    status: string;
    progress: number;
    stage: string;
    error?: string | null;
    output?: {
      id: string;
      name: string;
      downloadUrl?: string;
    } | null;
  };
};

type Preset = {
  id: string;
  name: string;
  target: string;
  options: {
    quality: number;
    stripMetadata: boolean;
    lossless: boolean;
  };
  createdAt: string;
};

type PresetsResponse = {
  presets: Preset[];
};

const ALL_TARGETS_VALUE = "all";
const START_CONVERSION_CONCURRENCY = 2;

// Fix 15: Added `failed` flag — sibling workers stop on first task error
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  let failed = false;
  const workerCount = Math.min(limit, items.length);

  async function worker(): Promise<void> {
    while (nextIndex < items.length && !failed) {
      const item = items[nextIndex]!;
      nextIndex += 1;
      try {
        await task(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function iconFor(ext: string) {
  if (["png", "jpg", "jpeg", "webp", "svg", "gif", "bmp", "tiff", "ico", "heic"].includes(ext)) return ImageIcon;
  if (["mp4", "mov", "avi", "mkv", "webm", "flv", "mp3", "wav", "aac", "flac", "ogg", "m4a"].includes(ext)) return Video;
  return FileText;
}

function fileSize(bytes: number) {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function normalizeJobStatus(status: string): UploadRow["status"] {
  const normalized = status.toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "failed" || normalized === "canceled") return "failed";
  if (normalized === "running") return "running";
  return "queued";
}

export function ConverterDashboard() {
  const { getToken } = useAuth();

  // Fix 7: Stabilize getToken reference. Effects read getTokenRef.current() so
  // they don't re-run (and tear down WebSocket) on every Clerk JWT refresh.
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const [rows, setRows] = useState<UploadRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const [quality, setQuality] = useState(86);
  const [stripMetadata, setStripMetadata] = useState(true);
  const [lossless, setLossless] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const [loadingPresets, setLoadingPresets] = useState(true);
  const fileStore = useRef(new Map<string, File>());

  // Fix 15: Prevent duplicate in-flight download URL fetches per asset
  const fetchingAssets = useRef(new Set<string>());

  const activeJobKey = useMemo(
    () =>
      rows
        .filter((row) => row.jobId && ["queued", "running"].includes(row.status))
        .map((row) => row.jobId)
        .sort()
        .join(","),
    [rows]
  );

  const addFiles = useCallback((files: File[]) => {
    const nextRows = files.map((file) => {
      const extension = extensionOf(file.name);
      const targets = defaultTargets(extension);
      const id = crypto.randomUUID();
      fileStore.current.set(id, file);
      return {
        id,
        name: file.name,
        size: file.size,
        extension,
        targetFormat: targets[0] ?? "pdf",
        status: "ready" as const,
        progress: 0,
        stage: "ready"
      };
    });
    setRows((current) => [...nextRows, ...current]);
  }, []);

  // Fix 1 + Fix 7: Empty dependency array — connect once on mount.
  // getToken is accessed via getTokenRef.current() which is always current.
  // The auth token is sent as a post-connection JSON frame (not in the URL).
  useEffect(() => {
    let socket: WebSocket | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function scheduleReconnect() {
      if (cancelled) return;
      const delay = Math.min(30000, 1000 * 2 ** attempt);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        void connect();
      }, delay);
    }

    async function connect() {
      if (!isApiConfigured) return;
      await warmAuthSession(getTokenRef.current);
      if (cancelled) return;
      // Fix 1: Token intentionally NOT in URL. Sent as auth frame after onopen.
      socket = new WebSocket(websocketUrl(getDemoSession()));
      socket.onopen = async () => {
        attempt = 0;
        // Send auth frame immediately after connection opens
        const token = await getOptionalAuthToken(getTokenRef.current);
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "auth", token: token ?? undefined }));
        }
      };
      socket.onmessage = (message) => {
        let payload: {
          type: string;
          event?: {
            jobId: string;
            status: UploadRow["status"];
            progress: number;
            stage: string;
            outputAssetId?: string;
            error?: string;
          };
        };
        try {
          payload = JSON.parse(String(message.data)) as typeof payload;
        } catch {
          return;
        }
        if (payload.type !== "job.progress" || !payload.event) return;
        const event = payload.event;
        setRows((current) =>
          current.map((row) =>
            row.jobId === event.jobId
              ? {
                  ...row,
                  status: event.status,
                  progress: event.status === "running" ? Math.max(40, event.progress) : event.progress,
                  stage: event.stage,
                  outputAssetId: event.outputAssetId ?? row.outputAssetId,
                  error: event.error
                }
              : row
          )
        );
      };
      socket.onclose = scheduleReconnect;
      socket.onerror = () => socket?.close();
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Fix 7: empty deps — connect once on mount, token accessed via ref

  // Fix 7 + Fix 12: getToken called once per poll cycle via ref; shared auth
  // headers used for all job fetch calls instead of per-job token invocations.
  useEffect(() => {
    if (!isApiConfigured || !activeJobKey) return;
    let cancelled = false;
    const jobIds = activeJobKey.split(",").filter(Boolean);
    const poll = async () => {
      // Fix 12: Single getToken call per poll cycle
      const auth = await authHeaders(getTokenRef.current);
      const results = await Promise.allSettled(
        jobIds.map((jobId) =>
          fetch(`${API_URL}/api/conversions/${jobId}`, {
            credentials: "include",
            headers: { "content-type": "application/json", ...auth }
          }).then((r) => r.json() as Promise<JobStateResponse>)
        )
      );
      if (cancelled) return;
      setRows((current) =>
        current.map((row) => {
          if (!row.jobId) return row;
          const result = results.find((item) => item.status === "fulfilled" && item.value.job.id === row.jobId);
          if (!result || result.status !== "fulfilled") return row;
          const job = result.value.job;
          const status = normalizeJobStatus(job.status);
          return {
            ...row,
            status,
            progress: status === "running" ? Math.max(row.progress, job.progress) : job.progress,
            stage: job.stage,
            outputAssetId: job.output?.id ?? row.outputAssetId,
            downloadUrl: job.output?.downloadUrl ?? row.downloadUrl,
            error: job.error ?? row.error
          };
        })
      );
    };
    const timer = setInterval(() => {
      void poll();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeJobKey]); // Fix 7: getToken removed from deps — accessed via ref

  // Fix 7 + Fix 15: fetchingAssets ref prevents duplicate in-flight requests
  // for the same asset when rows state updates trigger this effect multiple times.
  useEffect(() => {
    const completed = rows.filter((row) => row.status === "completed" && row.outputAssetId && !row.downloadUrl);
    for (const row of completed) {
      const assetId = row.outputAssetId!;
      if (fetchingAssets.current.has(assetId)) continue;
      fetchingAssets.current.add(assetId);
      apiFetch<{ downloadUrl: string }>(`/api/conversions/assets/${assetId}/download`, {}, getTokenRef.current)
        .then((result) => {
          setRows((current) => current.map((item) => (item.id === row.id ? { ...item, downloadUrl: result.downloadUrl } : item)));
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Download URL fetch failed";
          setRows((current) => current.map((item) => (item.id === row.id ? { ...item, error: message } : item)));
        })
        .finally(() => {
          fetchingAssets.current.delete(assetId);
        });
    }
  }, [rows]); // Fix 7: getToken removed from deps — accessed via ref

  useEffect(() => {
    loadPresets();
  }, []);

  async function loadPresets() {
    if (!isApiConfigured) {
      setLoadingPresets(false);
      return;
    }
    try {
      const result = await apiFetch<PresetsResponse>("/api/presets", {}, getTokenRef.current);
      setPresets(result.presets);
    } catch {
      // ignore errors
    } finally {
      setLoadingPresets(false);
    }
  }

  async function savePreset() {
    if (!presetName.trim() || savingPreset || !isApiConfigured) return;
    setSavingPreset(true);
    try {
      await apiFetch<{ preset: Preset }>(
        "/api/presets",
        {
          method: "POST",
          body: JSON.stringify({
            name: presetName.trim(),
            target: rows[0]?.extension ?? "pdf",
            options: { quality, stripMetadata, lossless }
          })
        },
        getTokenRef.current
      );
      setPresetName("");
      await loadPresets();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save preset";
      alert(message);
    } finally {
      setSavingPreset(false);
    }
  }

  async function deletePreset(id: string) {
    if (!isApiConfigured) return;
    try {
      await apiFetch(`/api/presets/${id}`, { method: "DELETE" }, getTokenRef.current);
      setPresets((current) => current.filter((p) => p.id !== id));
    } catch {
      // ignore errors
    }
  }

  function applyPreset(preset: Preset) {
    setQuality(preset.options.quality ?? 86);
    setStripMetadata(preset.options.stripMetadata ?? true);
    setLossless(preset.options.lossless ?? false);
  }

  const activeCount = useMemo(() => rows.filter((row) => ["uploading", "queued", "running"].includes(row.status)).length, [rows]);
  const completedCount = useMemo(() => rows.filter((row) => row.status === "completed").length, [rows]);

  // Fix 7: useCallback gives a stable reference; deps are the values this closure reads
  const startConversions = useCallback(async () => {
    if (!isApiConfigured) {
      setRows((current) =>
        current.map((item) =>
          item.status === "ready"
            ? { ...item, status: "failed", stage: "backend not connected", error: API_NOT_CONFIGURED_MESSAGE }
            : item
        )
      );
      return;
    }

    const ready = rows.filter((row) => row.status === "ready");
    await runWithConcurrency(ready, START_CONVERSION_CONCURRENCY, async (row) => {
      const file = fileStore.current.get(row.id);
      if (!file) return;
      const targets = defaultTargets(row.extension);
      const targetFormats = row.targetFormat === ALL_TARGETS_VALUE ? allTargets(row.extension) : [row.targetFormat];
      if (!targetFormats.length) {
        setRows((current) =>
          current.map((item) =>
            item.id === row.id ? { ...item, status: "failed", stage: "failed", error: `No targets for .${row.extension}` } : item
          )
        );
        return;
      }
      try {
        setRows((current) => current.map((item) => (item.id === row.id ? { ...item, status: "uploading", stage: "uploading chunks", progress: 1 } : item)));
        const upload = await uploadFileInChunks({
          file,
          getToken: getTokenRef.current,
          onProgress: (percent) =>
            setRows((current) => current.map((item) => (item.id === row.id ? { ...item, progress: percent } : item)))
        });
        setRows((current) => current.map((item) => (item.id === row.id ? { ...item, uploadId: upload.uploadId, stage: "queued", status: "queued", progress: 40 } : item)));

        const response = await apiFetch<ConversionResponse>(
          "/api/conversions",
          {
            method: "POST",
            body: JSON.stringify({
              files: targetFormats.map((targetFormat) => ({
                  uploadId: upload.uploadId,
                  targetFormat,
                  options: {
                    quality,
                    stripMetadata,
                    lossless
                  }
                }))
            })
          },
          getTokenRef.current
        );
        if (targetFormats.length === 1) {
          const jobId = response.jobs[0]?.id;
          setRows((current) => current.map((item) => (item.id === row.id ? { ...item, uploadId: upload.uploadId, jobId, status: "queued", progress: 42 } : item)));
          return;
        }

        const jobsByTarget = new Map(response.jobs.map((job) => [job.targetFormat, job]));
        const expandedRows: UploadRow[] = targetFormats.map((targetFormat) => {
          const job = jobsByTarget.get(targetFormat) ?? response.jobs.find((item) => item.targetFormat === targetFormat);
          return {
            id: crypto.randomUUID(),
            name: row.name,
            size: row.size,
            extension: row.extension,
            targetFormat,
            status: "queued",
            progress: 42,
            stage: "queued",
            uploadId: upload.uploadId,
            jobId: job?.id
          };
        });
        fileStore.current.delete(row.id);
        setRows((current) => current.flatMap((item) => (item.id === row.id ? expandedRows : [item])));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Conversion failed";
        setRows((current) => current.map((item) => (item.id === row.id ? { ...item, status: "failed", stage: "failed", error: message } : item)));
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, quality, stripMetadata, lossless]); // Fix 7: stable callback

  function removeRow(id: string) {
    fileStore.current.delete(id);
    setRows((current) => current.filter((row) => row.id !== id));
  }

  async function exportZip() {
    const jobIds = rows.filter((row) => row.status === "completed" && row.jobId).map((row) => row.jobId!);
    if (!jobIds.length) return;
    if (!isApiConfigured) throw new Error(API_NOT_CONFIGURED_MESSAGE);
    const auth = await authHeaders(getTokenRef.current);
    const response = await fetch(`${API_URL}/api/conversions/zip`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...auth
      },
      body: JSON.stringify({ jobIds })
    });
    if (!response.ok) throw new Error("ZIP export failed");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "omniconvert-results.zip";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
        <motion.section
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass min-h-[560px] rounded-2xl p-5 sm:p-6"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.28em] text-neon-cyan">Conversion Control</p>
              <h1 className="mt-2 text-3xl font-black tracking-tight text-white sm:text-4xl">OmniConvert AI</h1>
            </div>
            <div className="flex gap-2">
              <button
                onClick={exportZip}
                disabled={!completedCount}
                className="focus-ring inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs font-bold text-slate-200 transition hover:border-neon-cyan disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Archive size={15} />
                ZIP
              </button>
              <button
                onClick={startConversions}
                disabled={!rows.some((row) => row.status === "ready")}
                className="focus-ring inline-flex items-center gap-2 rounded-lg bg-neon-cyan px-4 py-2 text-xs font-black text-ink shadow-glow transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Play size={15} />
                Convert
              </button>
            </div>
          </div>

          {!isApiConfigured ? (
            <div className="mt-5 rounded-xl border border-neon-cyan/25 bg-neon-cyan/10 px-4 py-3 text-sm font-bold leading-6 text-slate-100">
              Frontend preview is live. Real cloud conversions will switch on when the backend service is connected.
            </div>
          ) : null}

          <label
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              addFiles(Array.from(event.dataTransfer.files));
            }}
            className={`mt-6 flex min-h-52 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed p-6 text-center transition ${
              dragging ? "border-neon-cyan bg-neon-cyan/10" : "border-slate-500/30 bg-white/[0.03] hover:border-neon-cyan/70"
            }`}
          >
            <CloudUpload className="mb-4 text-neon-cyan" size={38} />
            <span className="text-sm font-black text-white">Drop files or select from device</span>
            <span className="mt-2 max-w-xl text-xs leading-6 text-slate-400">
              PNG, JPG, WEBP, SVG, GIF, BMP, TIFF, ICO, HEIC, PDF, DOCX, DOC, TXT, RTF, ODT, HTML, Markdown, EPUB, PPTX, PPT, MP4, MOV, AVI, MKV, WEBM, FLV, MP3, WAV, AAC, FLAC, OGG, M4A.
            </span>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(event) => addFiles(Array.from(event.target.files ?? []))}
            />
          </label>

          <div className="mt-6 overflow-hidden rounded-2xl border border-line">
            <div className="grid grid-cols-[1.5fr_0.7fr_0.9fr_0.5fr] bg-white/[0.04] px-4 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              <span>File</span>
              <span>Target</span>
              <span>Status</span>
              <span className="text-right">Output</span>
            </div>
            <div className="max-h-[420px] divide-y divide-line overflow-auto scrollbar-thin">
              {rows.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-slate-500">No files queued.</div>
              ) : (
                rows.map((row) => {
                  const Icon = iconFor(row.extension);
                  const targets = defaultTargets(row.extension);
                  return (
                    <div key={row.id} className="grid grid-cols-[1.5fr_0.7fr_0.9fr_0.5fr] items-center gap-3 px-4 py-4 text-sm">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/7 text-neon-cyan">
                          <Icon size={18} />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-bold text-white">{row.name}</div>
                          <div className="text-xs text-slate-500">{fileSize(row.size)} · {row.extension.toUpperCase()}</div>
                        </div>
                      </div>
                      <select
                        value={row.targetFormat}
                        disabled={row.status !== "ready"}
                        onChange={(event) =>
                          setRows((current) => current.map((item) => (item.id === row.id ? { ...item, targetFormat: event.target.value } : item)))
                        }
                        className="focus-ring w-full rounded-lg border border-line bg-ink px-3 py-2 text-xs font-bold text-slate-200 disabled:opacity-50"
                      >
                        {targets.length > 1 ? <option value={ALL_TARGETS_VALUE}>ALL</option> : null}
                        {targets.map((target) => (
                          <option key={target} value={target}>
                            {target.toUpperCase()}
                          </option>
                        ))}
                      </select>
                      <div>
                        <div className="flex items-center gap-2 text-xs font-bold text-slate-300">
                          {row.status === "completed" ? <CheckCircle2 size={14} className="text-neon-lime" /> : null}
                          {["uploading", "queued", "running"].includes(row.status) ? <Loader2 size={14} className="animate-spin text-neon-cyan" /> : null}
                          <span className="truncate">{row.error ?? row.stage}</span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                          <div className="h-full rounded-full bg-neon-cyan transition-all" style={{ width: `${row.progress}%` }} />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        {row.downloadUrl ? (
                          <a
                            href={row.downloadUrl}
                            className="focus-ring rounded-lg bg-white px-3 py-2 text-xs font-black text-ink"
                          >
                            <Download size={14} />
                          </a>
                        ) : null}
                        <button
                          onClick={() => removeRow(row.id)}
                          className="focus-ring rounded-lg border border-line px-3 py-2 text-slate-400 hover:border-neon-rose hover:text-neon-rose"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </motion.section>

        <aside className="space-y-6">
          <section className="glass rounded-2xl p-5">
            <div className="flex items-center gap-3">
              <Settings2 className="text-neon-violet" size={19} />
              <h2 className="text-sm font-black text-white">Preset</h2>
            </div>
            <div className="mt-5 space-y-5">
              <label className="block">
                <span className="text-xs font-bold text-slate-400">Quality</span>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={quality}
                  onChange={(event) => setQuality(Number(event.target.value))}
                  className="mt-3 w-full accent-neon-cyan"
                />
                <span className="text-xs text-slate-500">{quality}%</span>
              </label>
              <label className="flex items-center justify-between rounded-lg border border-line bg-white/[0.03] px-3 py-3 text-xs font-bold text-slate-300">
                Metadata strip
                <input type="checkbox" checked={stripMetadata} onChange={(event) => setStripMetadata(event.target.checked)} className="accent-neon-cyan" />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-line bg-white/[0.03] px-3 py-3 text-xs font-bold text-slate-300">
                Lossless image mode
                <input type="checkbox" checked={lossless} onChange={(event) => setLossless(event.target.checked)} className="accent-neon-cyan" />
              </label>
            </div>

            <div className="mt-5 space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                  placeholder="Preset name"
                  className="focus-ring flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-xs font-bold text-white placeholder:text-slate-500"
                />
                <button
                  onClick={savePreset}
                  disabled={!presetName.trim() || savingPreset || !isApiConfigured}
                  className="focus-ring inline-flex items-center gap-2 rounded-lg bg-neon-cyan px-3 py-2 text-xs font-black text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Save size={14} />
                  {savingPreset ? "Saving..." : "Save"}
                </button>
              </div>

              {loadingPresets ? (
                <div className="text-xs text-slate-500 text-center py-2">Loading presets...</div>
              ) : presets.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Saved Presets</div>
                  {presets.map((preset) => (
                    <div key={preset.id} className="flex items-center justify-between rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-xs">
                      <div className="flex items-center gap-3 min-w-0">
                        <button
                          onClick={() => applyPreset(preset)}
                          className="flex-1 text-left truncate font-bold text-white hover:text-neon-cyan transition"
                        >
                          {preset.name}
                        </button>
                        <span className="text-slate-500 whitespace-nowrap">{preset.target.toUpperCase()} · Q:{preset.options.quality}</span>
                      </div>
                      <button
                        onClick={() => deletePreset(preset.id)}
                        className="focus-ring rounded-lg border border-line px-2 py-1 text-slate-400 hover:border-neon-rose hover:text-neon-rose"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-slate-500 text-center py-2">No presets saved yet</div>
              )}
            </div>
          </section>

          <section className="glass rounded-2xl p-5">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-xl border border-line bg-white/[0.03] p-4">
                <div className="text-2xl font-black text-white">{rows.length}</div>
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Queued</div>
              </div>
              <div className="rounded-xl border border-line bg-white/[0.03] p-4">
                <div className="text-2xl font-black text-neon-cyan">{activeCount}</div>
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Active</div>
              </div>
              <div className="rounded-xl border border-line bg-white/[0.03] p-4">
                <div className="text-2xl font-black text-neon-lime">{completedCount}</div>
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Done</div>
              </div>
            </div>
          </section>

          <section className="glass rounded-2xl p-5">
            <div className="flex items-center gap-3">
              <ShieldCheck className="text-neon-lime" size={19} />
              <h2 className="text-sm font-black text-white">Pipeline</h2>
            </div>
            <div className="mt-4 space-y-3 text-xs text-slate-400">
              {["Chunk upload", "MIME validation", "Malware scan", "S3 object storage", "BullMQ worker", "Signed output URL"].map((item) => (
                <div key={item} className="flex items-center justify-between rounded-lg border border-line bg-white/[0.03] px-3 py-2">
                  <span>{item}</span>
                  <span className="h-2 w-2 rounded-full bg-neon-lime" />
                </div>
              ))}
            </div>
          </section>

          {rows.find((row) => row.downloadUrl) ? (
            <section className="glass rounded-2xl p-5">
              <div className="flex items-center gap-3">
                <QrCode className="text-neon-cyan" size={19} />
                <h2 className="text-sm font-black text-white">QR Share</h2>
              </div>
              <div className="mt-4 rounded-xl bg-white p-4">
                <QRCodeSVG value={rows.find((row) => row.downloadUrl)?.downloadUrl ?? ""} size={160} className="mx-auto" />
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
