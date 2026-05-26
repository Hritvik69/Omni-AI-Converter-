"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Bot, Download, FileScan, ImageOff, Loader2, Lock, Mic2, Sparkles, Unlock, UploadCloud, Wand2 } from "lucide-react";
import { API_NOT_CONFIGURED_MESSAGE, apiFetch, isApiConfigured, warmAuthSession, websocketUrl } from "../lib/api";
import { extensionOf } from "../lib/formats";
import { uploadFileInChunks } from "../lib/upload";

const tools = [
  { id: "ocr", label: "AI OCR Scanner", icon: FileScan },
  { id: "image-encryption", label: "Image/File Encryption", icon: Lock },
  { id: "pdf-summary", label: "AI PDF Summarizer", icon: Sparkles },
  { id: "speech-to-text", label: "AI Speech-to-Text", icon: Mic2 },
  { id: "subtitle-generator", label: "AI Subtitle Generator", icon: Bot },
  { id: "image-upscale", label: "AI Image Upscaler", icon: Wand2 },
  { id: "background-remove", label: "AI Background Remover", icon: ImageOff },
  { id: "document-analyzer", label: "AI Document Analyzer", icon: FileScan },
  { id: "file-repair", label: "AI File Repair", icon: Wand2 }
] as const;

type ToolId = (typeof tools)[number]["id"];
type EncryptionMode = "encrypt" | "decrypt";

type AiJobResponse = {
  job: { id: string };
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

const encryptedFileBegin = "-----BEGIN OMNICONVERT ENCRYPTED FILE-----";
const encryptedFileEnd = "-----END OMNICONVERT ENCRYPTED FILE-----";
const encryptionIterations = 210000;
const textEncoder = new TextEncoder();

type EncryptedFileHeader = {
  version: 1;
  type: "omniconvert.encrypted-file";
  algorithm: "AES-256-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  name: string;
  mime: string;
  size: number;
};

type EncryptedFilePayload = EncryptedFileHeader & {
  ciphertext: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(index, index + chunkSize)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function safeDownloadName(name: string): string {
  return (name || "decrypted-file").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180) || "decrypted-file";
}

function normalizeJobStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "failed" || normalized === "canceled") return "failed";
  if (normalized === "running") return "running";
  return "queued";
}

function encryptedOutputName(name: string): string {
  const safeName = safeDownloadName(name);
  const base = safeName.replace(/\.[^.]+$/, "") || "encrypted-file";
  return `${base}.omnilock.txt`;
}

function aadForPayload(payload: EncryptedFileHeader | EncryptedFilePayload): Uint8Array {
  const header: EncryptedFileHeader = {
    version: 1,
    type: "omniconvert.encrypted-file",
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: payload.iterations,
    salt: payload.salt,
    iv: payload.iv,
    name: payload.name,
    mime: payload.mime,
    size: payload.size
  };
  return textEncoder.encode(JSON.stringify(header));
}

async function deriveEncryptionKey(password: string, salt: Uint8Array, usages: KeyUsage[], iterations = encryptionIterations): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error("Browser encryption API is not available");
  const keyMaterial = await crypto.subtle.importKey("raw", toArrayBuffer(textEncoder.encode(password)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

function parseEncryptedPayload(text: string): EncryptedFilePayload {
  const trimmed = text.trim();
  const begin = trimmed.indexOf(encryptedFileBegin);
  const end = trimmed.indexOf(encryptedFileEnd);
  const json = begin >= 0 && end > begin
    ? trimmed.slice(begin + encryptedFileBegin.length, end).trim()
    : trimmed;
  const payload = JSON.parse(json) as Partial<EncryptedFilePayload>;
  if (
    payload.version !== 1 ||
    payload.type !== "omniconvert.encrypted-file" ||
    payload.algorithm !== "AES-256-GCM" ||
    payload.kdf !== "PBKDF2-SHA256" ||
    typeof payload.iterations !== "number" ||
    typeof payload.salt !== "string" ||
    typeof payload.iv !== "string" ||
    typeof payload.ciphertext !== "string"
  ) {
    throw new Error("This is not an OmniConvert encrypted text file");
  }
  return payload as EncryptedFilePayload;
}

async function encryptFileToText(file: File, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const inputBytes = new Uint8Array(await file.arrayBuffer());
  const key = await deriveEncryptionKey(password, salt, ["encrypt"]);
  const header: EncryptedFileHeader = {
    version: 1,
    type: "omniconvert.encrypted-file",
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: encryptionIterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size
  };
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aadForPayload(header)) },
    key,
    toArrayBuffer(inputBytes)
  );
  const payload: EncryptedFilePayload = {
    ...header,
    ciphertext: bytesToBase64(new Uint8Array(encrypted))
  };
  return `${encryptedFileBegin}\n${JSON.stringify(payload, null, 2)}\n${encryptedFileEnd}\n`;
}

async function decryptTextToFile(text: string, password: string): Promise<{ bytes: Uint8Array; name: string; mime: string }> {
  const payload = parseEncryptedPayload(text);
  const salt = base64ToBytes(payload.salt);
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);
  const key = await deriveEncryptionKey(password, salt, ["decrypt"], payload.iterations);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aadForPayload(payload)) },
    key,
    toArrayBuffer(ciphertext)
  );
  return {
    bytes: new Uint8Array(decrypted),
    name: safeDownloadName(payload.name),
    mime: payload.mime || "application/octet-stream"
  };
}

export function AiToolsPanel() {
  const { getToken } = useAuth();
  const [tool, setTool] = useState<ToolId>("ocr");
  const [fileMeta, setFileMeta] = useState<{ name: string; size: number; ext: string } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("ready");
  const [outputAssetId, setOutputAssetId] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [encryptionMode, setEncryptionMode] = useState<EncryptionMode>("encrypt");
  const [password, setPassword] = useState("");
  const fileRef = useRef<File | null>(null);

  const isEncryptionTool = tool === "image-encryption";
  const isBusy = ["uploading", "queued", "running", "encrypting", "decrypting"].includes(status);

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
      await warmAuthSession(getToken);
      const token = await getToken().catch(() => null);
      if (cancelled) return;
      socket = new WebSocket(websocketUrl(token));
      socket.onopen = () => {
        attempt = 0;
      };
      socket.onmessage = (message) => {
        let payload: {
          type: string;
          event?: {
            jobId: string;
            status: string;
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
        if (payload.type !== "job.progress" || payload.event?.jobId !== jobId) return;
        setStatus(payload.event.status);
        setProgress(payload.event.progress);
        setStage(payload.event.stage);
        setError(payload.event.error ?? null);
        if (payload.event.outputAssetId) setOutputAssetId(payload.event.outputAssetId);
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
  }, [getToken, jobId]);

  useEffect(() => {
    if (!jobId || !["queued", "running"].includes(status) || !isApiConfigured) return;
    let cancelled = false;
    const timer = setInterval(() => {
      apiFetch<JobStateResponse>(`/api/conversions/${jobId}`, {}, getToken)
        .then((result) => {
          if (cancelled) return;
          const nextStatus = normalizeJobStatus(result.job.status);
          setStatus(nextStatus);
          setProgress(result.job.progress);
          setStage(result.job.stage);
          setError(result.job.error ?? null);
          if (result.job.output?.id) setOutputAssetId(result.job.output.id);
          if (result.job.output?.downloadUrl) setDownloadUrl(result.job.output.downloadUrl);
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [getToken, jobId, status]);

  useEffect(() => {
    if (status !== "completed" || !outputAssetId || downloadUrl) return;
    apiFetch<{ downloadUrl: string }>(`/api/conversions/assets/${outputAssetId}/download`, {}, getToken)
      .then((result) => setDownloadUrl(result.downloadUrl))
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Download link failed"));
  }, [downloadUrl, getToken, outputAssetId, status]);

  useEffect(() => {
    return () => {
      if (downloadUrl?.startsWith("blob:")) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  function resetRunState() {
    setError(null);
    setDownloadUrl(null);
    setDownloadName(null);
    setOutputAssetId(null);
    setJobId(null);
  }

  async function runEncryptionTool() {
    const file = fileRef.current;
    if (!file) return;
    if (password.trim().length < 6) {
      setStatus("failed");
      setStage("failed");
      setProgress(100);
      setError("Use a password with at least 6 characters");
      return;
    }

    try {
      resetRunState();
      setStatus(encryptionMode === "encrypt" ? "encrypting" : "decrypting");
      setStage(encryptionMode === "encrypt" ? "encrypting file" : "decrypting text");
      setProgress(20);

      if (encryptionMode === "encrypt") {
        const encryptedText = await encryptFileToText(file, password);
        const blob = new Blob([encryptedText], { type: "text/plain;charset=utf-8" });
        const nextUrl = URL.createObjectURL(blob);
        setDownloadName(encryptedOutputName(file.name));
        setDownloadUrl(nextUrl);
        setStage("encrypted text ready");
      } else {
        const text = await file.text();
        const decrypted = await decryptTextToFile(text, password);
        const blob = new Blob([toArrayBuffer(decrypted.bytes)], { type: decrypted.mime });
        const nextUrl = URL.createObjectURL(blob);
        setDownloadName(decrypted.name);
        setDownloadUrl(nextUrl);
        setStage("decrypted file ready");
      }

      setStatus("completed");
      setProgress(100);
    } catch (caught) {
      setStatus("failed");
      setStage("failed");
      setProgress(100);
      if (encryptionMode === "decrypt" && caught instanceof Error && !caught.message.startsWith("This is not")) {
        setError("Wrong password or encrypted text is damaged");
      } else {
        setError(caught instanceof Error ? caught.message : "Encryption tool failed");
      }
    }
  }

  async function runTool() {
    if (!fileRef.current) return;
    if (isEncryptionTool) {
      await runEncryptionTool();
      return;
    }
    if (!isApiConfigured) {
      setStatus("failed");
      setStage("backend not connected");
      setProgress(100);
      setError(API_NOT_CONFIGURED_MESSAGE);
      return;
    }
    try {
      resetRunState();
      setStatus("uploading");
      setProgress(1);
      setStage("uploading source");
      const upload = await uploadFileInChunks({
        file: fileRef.current,
        getToken,
        onProgress: (value) => setProgress(value)
      });
      setStage("queued");
      setProgress(40);
      const response = await apiFetch<AiJobResponse>(
        "/api/conversions/ai",
        {
          method: "POST",
          body: JSON.stringify({
            uploadId: upload.uploadId,
            tool,
            options: {}
          })
        },
        getToken
      );
      setJobId(response.job.id);
      setStatus("queued");
    } catch (caught) {
      setStatus("failed");
      setStage("failed");
      setProgress(100);
      setError(caught instanceof Error ? caught.message : "AI tool failed");
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="glass rounded-2xl p-6">
        <p className="text-xs font-bold uppercase tracking-[0.28em] text-neon-cyan">AI Workbench</p>
        <h1 className="mt-2 text-3xl font-black text-white">AI Tools</h1>

        {!isApiConfigured ? (
          <div className="mt-5 rounded-xl border border-neon-cyan/25 bg-neon-cyan/10 px-4 py-3 text-sm font-bold leading-6 text-slate-100">
            Frontend preview is live. Browser encryption works now; cloud AI tools will switch on when the backend service is connected.
          </div>
        ) : null}

        <div className="mt-8 grid gap-6 lg:grid-cols-[0.75fr_1.25fr]">
          <div className="space-y-3">
            {tools.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setTool(item.id);
                    resetRunState();
                    setStage("ready");
                    setProgress(0);
                    setStatus("idle");
                  }}
                  className={`focus-ring flex w-full items-center gap-3 rounded-xl border px-4 py-4 text-left text-sm font-black transition ${
                    tool === item.id ? "border-neon-cyan bg-neon-cyan/10 text-white" : "border-line bg-white/[0.03] text-slate-300 hover:border-neon-cyan/60"
                  }`}
                >
                  <Icon size={18} className="text-neon-cyan" />
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="rounded-2xl border border-line bg-white/[0.03] p-5">
            <label className="flex min-h-56 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-slate-500/30 text-center transition hover:border-neon-cyan">
              <UploadCloud className="mb-4 text-neon-cyan" size={36} />
              <span className="text-sm font-black text-white">{fileMeta ? fileMeta.name : "Select a file"}</span>
              {fileMeta ? <span className="mt-2 text-xs text-slate-500">{(fileMeta.size / 1024 / 1024).toFixed(2)} MB · {fileMeta.ext.toUpperCase()}</span> : null}
              <input
                type="file"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  fileRef.current = file;
                  setDownloadUrl(null);
                  setOutputAssetId(null);
                  setJobId(null);
                  setError(null);
                  setStage("ready");
                  setProgress(0);
                  setStatus("idle");
                  if (file) setFileMeta({ name: file.name, size: file.size, ext: extensionOf(file.name) });
                }}
              />
            </label>

            {isEncryptionTool ? (
              <div className="mt-5 grid gap-3 sm:grid-cols-[0.7fr_1fr]">
                <div className="grid grid-cols-2 rounded-xl border border-line bg-ink p-1">
                  {(["encrypt", "decrypt"] as const).map((mode) => {
                    const active = encryptionMode === mode;
                    const Icon = mode === "encrypt" ? Lock : Unlock;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => {
                          setEncryptionMode(mode);
                          resetRunState();
                          setStage("ready");
                          setProgress(0);
                          setStatus("idle");
                        }}
                        className={`focus-ring flex items-center justify-center gap-2 rounded-lg px-3 py-3 text-xs font-black transition ${
                          active ? "bg-neon-cyan text-ink" : "text-slate-300 hover:bg-white/10"
                        }`}
                      >
                        <Icon size={14} />
                        {mode === "encrypt" ? "Encrypt" : "Decrypt"}
                      </button>
                    );
                  })}
                </div>
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  placeholder="Password"
                  className="focus-ring rounded-xl border border-line bg-ink px-4 py-3 text-xs font-bold text-white placeholder:text-slate-500"
                />
              </div>
            ) : null}

            <div className="mt-5 rounded-xl border border-line bg-ink p-4">
              <div className="flex items-start justify-between gap-3 text-xs font-bold text-slate-300">
                <span className={`min-w-0 break-words leading-5 ${error ? "text-neon-rose" : ""}`}>{error ?? stage}</span>
                <span className="shrink-0">{progress}%</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-neon-cyan transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>

            <div className="mt-5 flex gap-3">
              <button
                onClick={runTool}
                disabled={!fileRef.current || isBusy}
                className="focus-ring inline-flex items-center gap-2 rounded-lg bg-neon-cyan px-5 py-3 text-xs font-black text-ink shadow-glow transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isBusy ? <Loader2 className="animate-spin" size={15} /> : isEncryptionTool && encryptionMode === "encrypt" ? <Lock size={15} /> : isEncryptionTool ? <Unlock size={15} /> : <Sparkles size={15} />}
                {isEncryptionTool ? (encryptionMode === "encrypt" ? "Encrypt" : "Decrypt") : "Run"}
              </button>
              {downloadUrl ? (
                <a
                  href={downloadUrl}
                  download={downloadName ?? undefined}
                  className="focus-ring inline-flex items-center gap-2 rounded-lg border border-line px-5 py-3 text-xs font-black text-white hover:border-neon-cyan"
                >
                  <Download size={15} />
                  Download
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
