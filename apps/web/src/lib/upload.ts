import { API_URL, type AuthTokenGetter } from "./api";

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

async function authHeaders(getToken: AuthTokenGetter): Promise<HeadersInit> {
  const token = await getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function uploadFileInChunks(args: {
  file: File;
  getToken: AuthTokenGetter;
  onProgress: (percent: number) => void;
}): Promise<UploadCompleteResponse> {
  const sessionResponse = await fetch(`${API_URL}/api/uploads/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await authHeaders(args.getToken))
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

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * session.chunkSize;
    const end = Math.min(args.file.size, start + session.chunkSize);
    const response = await fetch(`${API_URL}/api/uploads/${session.uploadId}/chunks/${index}`, {
      method: "PUT",
      headers: await authHeaders(args.getToken),
      body: args.file.slice(start, end)
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error ?? `Chunk ${index + 1} failed`);
    }
    args.onProgress(Math.round(((index + 1) / totalChunks) * 35));
  }

  const completeResponse = await fetch(`${API_URL}/api/uploads/${session.uploadId}/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await authHeaders(args.getToken))
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
