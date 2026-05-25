export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type AuthTokenGetter = () => Promise<string | null>;

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  getToken?: AuthTokenGetter
): Promise<T> {
  const token = getToken ? await getToken() : null;
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
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

export function websocketUrl(token?: string | null): string {
  const base = new URL(API_URL);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws";
  if (token) base.searchParams.set("token", token);
  return base.toString();
}
