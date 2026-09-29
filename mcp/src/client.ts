type ClientConfig = Readonly<{
  apiUrl: string;
  panelUrl: string;
  email?: string;
  password?: string;
  sessionCookie?: string;
}>;

type ApiFailure = Readonly<{ error?: unknown }>;

function requiredUrl(name: string, value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) throw new Error(`missing environment variable: ${name}`);
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new Error(`${name} must be an absolute URL`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${name} must use http or https`);
  return parsed.toString().replace(/\/$/, "");
}

function sessionCookie(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("__Host-spawnpoint.session=")) return trimmed.split(";", 1)[0]!;
  return `__Host-spawnpoint.session=${trimmed}`;
}

export function configFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ClientConfig {
  const email = environment.SPAWNPOINT_EMAIL?.trim();
  const password = environment.SPAWNPOINT_PASSWORD;
  const configuredCookie = environment.SPAWNPOINT_SESSION_COOKIE?.trim();
  if (!configuredCookie && (!email || !password)) {
    throw new Error("set SPAWNPOINT_SESSION_COOKIE, or both SPAWNPOINT_EMAIL and SPAWNPOINT_PASSWORD");
  }
  return {
    apiUrl: requiredUrl("SPAWNPOINT_API_URL", environment.SPAWNPOINT_API_URL),
    panelUrl: requiredUrl("SPAWNPOINT_PANEL_URL", environment.SPAWNPOINT_PANEL_URL),
    ...(email ? { email } : {}),
    ...(password ? { password } : {}),
    ...(configuredCookie ? { sessionCookie: sessionCookie(configuredCookie) } : {}),
  };
}

function cookieFrom(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const match = /(?:^|,\s*)(__Host-spawnpoint\.session=[^;,\s]+)/.exec(value);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function failure(response: Response): Promise<Error> {
  const parsed = await response.json().catch(() => null) as ApiFailure | null;
  const code = typeof parsed?.error === "string" ? `: ${parsed.error}` : "";
  return new Error(`Spawnpoint API returned ${response.status}${code}`);
}

export class SpawnpointClient {
  readonly #config: ClientConfig;
  readonly #fetch: typeof fetch;
  #cookie: string | null;

  constructor(config: ClientConfig = configFromEnvironment(), fetchImplementation: typeof fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImplementation;
    this.#cookie = config.sessionCookie ?? null;
  }

  async #login(): Promise<void> {
    if (!this.#config.email || !this.#config.password) {
      throw new Error("the configured Spawnpoint session expired; configure email and password to renew it automatically");
    }
    const response = await this.#fetch(`${this.#config.apiUrl}/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.#config.email, password: this.#config.password }),
    });
    if (!response.ok) throw await failure(response);
    const cookie = cookieFrom(response);
    if (!cookie) throw new Error("Spawnpoint signed in without returning a browser session cookie");
    this.#cookie = cookie;
  }

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!path.startsWith("/")) throw new Error("Spawnpoint API paths must start with /");
    if (this.#cookie === null) await this.#login();
    const send = () => this.#fetch(`${this.#config.apiUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        origin: this.#config.panelUrl,
        cookie: this.#cookie!,
        ...init.headers,
      },
    });
    let response = await send();
    if (response.status === 401 && this.#config.email && this.#config.password) {
      await this.#login();
      response = await send();
    }
    if (!response.ok) throw await failure(response);
    if (response.status === 204) return null;
    return response.json() as Promise<unknown>;
  }
}
