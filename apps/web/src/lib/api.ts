const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

export const API_URL = configuredApiUrl ?? "http://localhost:4000";
export const isApiConfigured =
  Boolean(configuredApiUrl) ||
  process.env.NODE_ENV !== "production";

export const API_NOT_CONFIGURED_MESSAGE =
  "Cloud processing is not connected yet for this live preview.";

export type AuthTokenGetter = () => Promise<string | null>;

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  getToken?: AuthTokenGetter
): Promise<T> {
  if (!isApiConfigured) throw new Error(API_NOT_CONFIGURED_MESSAGE);

  const token = getToken ? await getToken() : null;
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error ?? "Request failed");
  }

  return response.json() as Promise<T>;
}

export async function warmAuthSession(getToken?: AuthTokenGetter): Promise<void> {
  if (!isApiConfigured) return;
  await apiFetch<{ ok: boolean }>("/api/conversions/auth/session", {}, getToken).catch(() => undefined);
}

export function websocketUrl(token?: string | null): string {
  if (!isApiConfigured) return "";
  const base = new URL(API_URL);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws";
  if (token) base.searchParams.set("token", token);
  return base.toString();
}
