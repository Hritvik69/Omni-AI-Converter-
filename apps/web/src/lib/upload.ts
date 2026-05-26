import {
  API_NOT_CONFIGURED_MESSAGE,
  API_URL,
  authHeaders,
  isApiConfigured,
  rememberDemoSessionFromResponse,
  type AuthTokenGetter
} from "./api";

type UploadSessionResponse = {
  uploadId: string;
  chunkSize: number;
  expiresAt: string;
};

type UploadCompleteResponse = {
  assetId: string;
  uploadId: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
};

const UPLOAD_CHUNK_CONCURRENCY = 3;
const UPLOAD_REQUEST_TIMEOUT_MS = 120000;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;
  const workerCount = Math.min(limit, items.length);

  async function worker(): Promise<void> {
    while (nextIndex < items.length && !firstError) {
      const item = items[nextIndex]!;
      nextIndex += 1;
      try {
        await task(item);
      } catch (error) {
        firstError = error;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = UPLOAD_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal;
  if (signal) {
    if (signal.aborted) controller.abort();
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(input, {
      ...init,
      credentials: "include",
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function abortUploadSession(uploadId: string, auth: Record<string, string>): Promise<void> {
  await fetchWithTimeout(`${API_URL}/api/uploads/${uploadId}/abort`, {
    method: "POST",
    headers: auth
  }).catch(() => undefined);
}

export async function uploadFileInChunks(args: {
  file: File;
  getToken: AuthTokenGetter;
  onProgress: (percent: number) => void;
}): Promise<UploadCompleteResponse> {
  if (!isApiConfigured) throw new Error(API_NOT_CONFIGURED_MESSAGE);
  let auth = await authHeaders(args.getToken);

  const sessionResponse = await fetchWithTimeout(`${API_URL}/api/uploads/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...auth
    },
    body: JSON.stringify({
      fileName: args.file.name,
      fileSize: args.file.size,
      mimeType: args.file.type || "application/octet-stream"
    })
  });
  rememberDemoSessionFromResponse(sessionResponse);

  if (!sessionResponse.ok) {
    const error = await sessionResponse.json().catch(() => null);
    throw new Error(error?.error ?? "Upload session failed");
  }

  const session = (await sessionResponse.json()) as UploadSessionResponse;
  auth = await authHeaders(args.getToken);
  const totalChunks = Math.ceil(args.file.size / session.chunkSize);
  let completedChunks = 0;
  const uploadController = new AbortController();

  try {
    await runWithConcurrency([...Array(totalChunks).keys()], UPLOAD_CHUNK_CONCURRENCY, async (index) => {
      const start = index * session.chunkSize;
      const end = Math.min(args.file.size, start + session.chunkSize);
      const response = await fetchWithTimeout(`${API_URL}/api/uploads/${session.uploadId}/chunks/${index}`, {
        method: "PUT",
        headers: auth,
        signal: uploadController.signal,
        body: args.file.slice(start, end)
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? `Chunk ${index + 1} failed`);
      }
      completedChunks += 1;
      args.onProgress(Math.round((completedChunks / totalChunks) * 35));
    });

    const completeResponse = await fetchWithTimeout(`${API_URL}/api/uploads/${session.uploadId}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...auth
      },
      signal: uploadController.signal,
      body: JSON.stringify({ totalChunks })
    });

    if (!completeResponse.ok) {
      const error = await completeResponse.json().catch(() => null);
      throw new Error(error?.error ?? "Upload completion failed");
    }

    args.onProgress(40);
    return completeResponse.json() as Promise<UploadCompleteResponse>;
  } catch (error) {
    uploadController.abort();
    await abortUploadSession(session.uploadId, auth);
    throw error;
  }
}
