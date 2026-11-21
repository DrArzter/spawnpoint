// Raw Chrome DevTools Protocol: one headless Chrome, one socket, a tab per worker.
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  return process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium";
}

/** Starts Chrome and returns { open, close }: `open()` gives a tab in its own browser context. */
export async function launch() {
  const profile = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), "audit-"));
  const port = randomInt(9600, 9900);
  const proc = spawn(chromePath(), [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--hide-scrollbars", "--font-render-hinting=none",
    // Tabs in the background keep their timers and frames, so they settle as the front one does.
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  // What Chrome says about itself, kept for the failure message.
  let complaints = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => { complaints = (complaints + chunk).slice(-2000); });
  let exit = null;
  proc.on("exit", (code, signal) => { exit = signal ?? code; });

  // A minute: a cold CI runner can take that long to open the debugging port.
  let endpoint = null;
  for (let i = 0; i < 600 && exit === null && endpoint === null; i += 1) {
    try {
      endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch { await sleep(100); }
  }
  if (!endpoint) {
    const why = exit === null ? "did not open its debugging port within 60s" : `exited with ${exit}`;
    throw new Error(`chrome ${why}${complaints ? `\n${complaints.trimEnd()}` : ""}`);
  }

  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method && message.sessionId) {
      listeners.get(message.sessionId)?.(message);
    }
  };
  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  async function open() {
    const { result: context } = await send("Target.createBrowserContext", { disposeOnDetach: true });
    const { result: created } = await send("Target.createTarget", { url: "about:blank", browserContextId: context.browserContextId });
    const { result: attached } = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    const sessionId = attached.sessionId;
    let onLoad = null;
    listeners.set(sessionId, (message) => { if (message.method === "Page.loadEventFired" && onLoad) onLoad(); });
    const tab = {
      send: (method, params = {}) => send(method, params, sessionId),
      /** Evaluates an expression and returns its value, or throws with the page's exception. */
      async evaluate(expression, awaitPromise = false) {
        const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId);
        const result = reply.result;
        if (!result || result.exceptionDetails) throw new Error((result?.exceptionDetails?.exception?.description ?? JSON.stringify(reply.error ?? result)).slice(0, 300));
        return result.result.value;
      },
      /** Navigates and waits for the load event (8 s cap). */
      async goto(url) {
        const loaded = new Promise((resolve) => { onLoad = resolve; });
        await send("Page.navigate", { url }, sessionId);
        await Promise.race([loaded, sleep(8000)]);
        onLoad = null;
      },
      async screenshot(clip) {
        const reply = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sessionId);
        return reply.result?.data ? Buffer.from(reply.result.data, "base64") : null;
      },
    };
    await tab.send("Page.enable");
    return tab;
  }

  function close() {
    try { ws.close(); } catch { /* closing */ }
    proc.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold it */ }
  }
  return { open, close };
}
