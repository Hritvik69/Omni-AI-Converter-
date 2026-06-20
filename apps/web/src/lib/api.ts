const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
const configuredClerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();

export const API_URL = configuredApiUrl ?? "http://localhost:4000";
export const isApiConfigured =
  Boolean(configuredApiUrl) ||
  process.env.NODE_ENV !== "production";
export const isClerkConfigured = Boolean(
  configuredClerkPublishableKey &&
    !configuredClerkPublishableKey.includes("replace_me") &&
    !configuredClerkPublishableKey.includes("clerk.local.dev")
);

export const API_NOT_CONFIGURED_MESSAGE =
  "Cloud processing is not connected yet for this live preview.";

export type AuthTokenGetter = () => Promise<string | null>;

const AUTH_TOKEN_TIMEOUT_MS = 4000;
const DEMO_SESSION_STORAGE_KEY = "omniconvert_demo_session";
let cachedDemoSession: string | null = null;

function readStoredDemoSession(): string | null {
  if (cachedDemoSession) return cachedDemoSession;
  if (typeof window === "undefined") return null;
  cachedDemoSession = window.localStorage.getItem(DEMO_SESSION_STORAGE_KEY);
  return cachedDemoSession;
}

function storeDemoSession(value: string): void {
  cachedDemoSession = value;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(DEMO_SESSION_STORAGE_KEY, value);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Auth token lookup timed out")), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export function rememberDemoSessionFromResponse(response: Response): void {
  const demoSession = response.headers.get("x-demo-session");
  if (demoSession) storeDemoSession(demoSession);
}

export function getDemoSession(): string | null {
  return readStoredDemoSession();
}

export async function getOptionalAuthToken(getToken?: AuthTokenGetter): Promise<string | null> {
  if (!getToken || !isClerkConfigured) return null;
  try {
    return await withTimeout(getToken(), AUTH_TOKEN_TIMEOUT_MS);
  } catch {
    return null;
  }
}

export async function authHeaders(getToken?: AuthTokenGetter): Promise<Record<string, string>> {
  const token = await getOptionalAuthToken(getToken);
  if (token) return { authorization: `Bearer ${token}` };

  const demoSession = readStoredDemoSession();
  return demoSession ? { "x-demo-session": demoSession } : {};
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  getToken?: AuthTokenGetter
): Promise<T> {
  if (!isApiConfigured) throw new Error(API_NOT_CONFIGURED_MESSAGE);

  const auth = await authHeaders(getToken);
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
      ...auth
    }
  });
  rememberDemoSessionFromResponse(response);

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

/**
 * Returns the WebSocket URL for the realtime gateway.
 * NOTE: The auth token is intentionally NOT included in the URL (Fix 1 — prevents
 * token exposure in server access logs, browser history, and proxy logs).
 * After connecting, the caller must send: { type: "auth", token: "<jwt>" }
 * demoSession is kept in the URL because it is not a secret credential.
 */
export function websocketUrl(demoSession?: string | null): string {
  if (!isApiConfigured) return "";
  const base = new URL(API_URL);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws";
  if (demoSession) base.searchParams.set("demoSession", demoSession);
  return base.toString();
}
