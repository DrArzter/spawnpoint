// Only the transport owns the API origin and browser-session renewal. Feature
// clients deal in responses, not credentials or fetch configuration.
export const apiUrl = (import.meta.env.VITE_ACCESS_API_URL ?? "").replace(/\/$/, "");

let refreshPromise: Promise<boolean> | null = null;

/** One call with the browser session's cookie and no renewal: sign-in, the session probe and logout. */
export function sessionFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiUrl}${path}`, { ...init, credentials: "include" });
}

async function requestRefresh(): Promise<boolean> {
  const response = await fetch(`${apiUrl}/auth/refresh`, { method: "POST", credentials: "include" });
  if (response.ok) return true;
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  if (body?.error !== "refresh_credential_rotated") return false;
  const retry = await fetch(`${apiUrl}/auth/refresh`, { method: "POST", credentials: "include" });
  return retry.ok;
}

export async function refreshBrowserSession(): Promise<boolean> {
  refreshPromise ??= requestRefresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () => sessionFetch(path, init);
  const first = await send();
  if (first.status !== 401) return first;
  return await refreshBrowserSession() ? send() : first;
}
