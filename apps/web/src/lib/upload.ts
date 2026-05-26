import { API_NOT_CONFIGURED_MESSAGE, API_URL, isApiConfigured, type AuthTokenGetter } from "./api";

type UploadSessionResponse = {
  uploadId: string;
  chunkSize: number;
};

type UploadCompleteResponse = {
  assetId: string;
  uploadId: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
};

const UPLOAD_CHUNK_CONCURRENCY = 3;

async function authHeaders(getToken: AuthTokenGetter): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

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

export async function uploadFileInChunks(args: {
  file: File;
  getToken: AuthTokenGetter;
  onProgress: (percent: number) => void;
}): Promise<UploadCompleteResponse> {
  if (!isApiConfigured) throw new Error(API_NOT_CONFIGURED_MESSAGE);
  const auth = await authHeaders(args.getToken);

  const sessionResponse = await fetch(`${API_URL}/api/uploads/sessions`, {
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

  if (!sessionResponse.ok) {
    const error = await sessionResponse.json().catch(() => null);
    throw new Error(error?.error ?? "Upload session failed");
  }

  const session = (await sessionResponse.json()) as UploadSessionResponse;
  const totalChunks = Math.ceil(args.file.size / session.chunkSize);
  let completedChunks = 0;

  await runWithConcurrency([...Array(totalChunks).keys()], UPLOAD_CHUNK_CONCURRENCY, async (index) => {
    const start = index * session.chunkSize;
    const end = Math.min(args.file.size, start + session.chunkSize);
    const response = await fetch(`${API_URL}/api/uploads/${session.uploadId}/chunks/${index}`, {
      method: "PUT",
      headers: auth,
      body: args.file.slice(start, end)
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error ?? `Chunk ${index + 1} failed`);
    }
    completedChunks += 1;
    args.onProgress(Math.round((completedChunks / totalChunks) * 35));
  });

  const completeResponse = await fetch(`${API_URL}/api/uploads/${session.uploadId}/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...auth
    },
    body: JSON.stringify({ totalChunks })
  });

  if (!completeResponse.ok) {
    const error = await completeResponse.json().catch(() => null);
    throw new Error(error?.error ?? "Upload completion failed");
  }

  args.onProgress(40);
  return completeResponse.json() as Promise<UploadCompleteResponse>;
}
