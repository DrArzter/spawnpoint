// Raw Chrome DevTools Protocol: one headless Chrome, one socket, a tab per worker.
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  return process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium";
}

/**
 * Starts Chrome and returns { open, close, gone, kill }: `open()` gives a tab in its own browser context.
 * A call fails, never waits, when Chrome has gone or stays silent for `callTimeoutMs`.
 */
export async function launch({ callTimeoutMs = 60_000 } = {}) {
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
  const state = { exit: null };
  proc.on("exit", (code, signal) => { state.exit = signal ?? code; });
  // A killed gate takes its Chrome with it; only SIGKILL leaves one behind.
  const stopChrome = () => { if (state.exit === null) proc.kill(); };
  process.once("exit", stopChrome);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      stopChrome();
      process.exit(128 + constants.signals[signal]);
    });
  }

  // A minute: a cold CI runner can take that long to open the debugging port.
  let endpoint = null;
  for (let i = 0; i < 600 && state.exit === null && endpoint === null; i += 1) {
    try {
      const reply = await fetch(`http://127.0.0.1:${port}/json/version`); // NOSONAR polling: each try waits for the last
      endpoint = (await reply.json()).webSocketDebuggerUrl; // NOSONAR polling: each try waits for the last
    } catch { await sleep(100); } // NOSONAR polling: each try waits for the last
  }
  if (!endpoint) {
    const why = state.exit === null ? "did not open its debugging port within 60s" : `exited with ${state.exit}`;
    const detail = complaints ? "\n" + complaints.trimEnd() : "";
    throw new Error(`chrome ${why}${detail}`);
  }

  // Dial the local port with the browser id alone; nothing else of the reply is used.
  const browserId = /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/([0-9a-f-]{36})$/.exec(endpoint)?.[1];
  if (!browserId) throw new Error("chrome offered an unexpected debugging endpoint");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/${browserId}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  // Why Chrome can no longer answer; every waiting and later call fails with it.
  let gone = null;
  const fail = (reason) => {
    if (gone !== null) return;
    gone = complaints ? `${reason}\n${complaints.trimEnd()}` : reason;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(gone));
    }
    pending.clear();
  };
  proc.on("exit", () => fail(`chrome exited with ${state.exit}`));
  ws.onclose = () => fail("chrome closed its debugging socket");
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const call = message.id ? pending.get(message.id) : undefined;
    if (call) {
      clearTimeout(call.timer);
      pending.delete(message.id);
      call.resolve(message);
    } else if (message.method && message.sessionId) {
      listeners.get(message.sessionId)?.(message);
    }
  };
  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
    if (gone !== null) {
      reject(new Error(gone));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`chrome did not answer ${method} within ${callTimeoutMs / 1000}s`));
    }, callTimeoutMs);
    pending.set(id, { resolve, reject, timer });
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
    gone ??= "chrome was closed";
    try { ws.close(); } catch { /* closing */ }
    proc.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold it */ }
  }
  return {
    open,
    close,
    /** Why Chrome can no longer answer, or null while it can. */
    gone: () => gone,
    /** Ends Chrome as a crash would; the self-test proves that calls then fail. */
    kill: () => proc.kill("SIGKILL"),
  };
}
