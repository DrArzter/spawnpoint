import { resetDemoState } from "./store";

export { demoSession } from "./data";
export * as demo from "./store";

const FLAG_KEY = "spawnpoint.demo";

function readFlag(): boolean {
  const query = new URLSearchParams(window.location.search);
  // `?preview` stays an alias so older links and the dev fixtures keep working.
  const asked = query.has("demo") || query.has("preview");
  try {
    if (asked) window.sessionStorage.setItem(FLAG_KEY, "1");
    return asked || window.sessionStorage.getItem(FLAG_KEY) === "1";
  } catch {
    // Storage is blocked; the query string alone still carries the mode.
    return asked;
  }
}

/** In-memory mode: no network call leaves the tab, and nothing survives a reload. */
export const demoEnabled = readFlag();

export const demoHash = "?demo#/worlds";

export function demoUrl(): string {
  return `${window.location.pathname}${demoHash}`;
}

export function resetDemo(): void {
  resetDemoState();
}

export function leaveDemo(): void {
  try {
    window.sessionStorage.removeItem(FLAG_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
  window.location.assign(`${window.location.pathname}#/`);
}

export async function demoLatency(): Promise<void> {
  if (!demoEnabled) return;
  const requested = Number(new URLSearchParams(window.location.search).get("latency"));
  const delay = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 5000) : 140;
  await new Promise((resolve) => window.setTimeout(resolve, delay));
}
