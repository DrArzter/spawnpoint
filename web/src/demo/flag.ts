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

export function demoUrl(): string {
  return `${window.location.pathname}?demo#/worlds`;
}

export function clearDemoFlag(): void {
  try {
    window.sessionStorage.removeItem(FLAG_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

/**
 * How long a demo answer takes. A call is quick; the two answers the panel
 * boots on (the session, the first snapshot) take long enough for the boot
 * screens to be seen, which is what a demo is for. `?latency=` overrides
 * both, and `?latency=0` makes everything immediate, which is how the UI
 * audit reaches the pages rather than the boot card.
 */
const BOOT_LATENCY_MS = 700;
const CALL_LATENCY_MS = 140;

function requestedLatency(): number | null {
  const raw = new URLSearchParams(window.location.search).get("latency");
  if (raw === null) return null;
  const requested = Number(raw);
  return Number.isFinite(requested) && requested >= 0 ? Math.min(requested, 5000) : null;
}

export async function demoLatency(kind: "call" | "boot" = "call"): Promise<void> {
  const delay = requestedLatency() ?? (kind === "boot" ? BOOT_LATENCY_MS : CALL_LATENCY_MS);
  if (delay === 0) return;
  await new Promise((resolve) => window.setTimeout(resolve, delay));
}
