// Runtime UI audit: every route at every breakpoint, probed in the page.
// node audit.mjs <baseUrl> <out.json> [light|dark]
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [base = "http://localhost:5173", out = "audit.json", scheme = "light"] = process.argv.slice(2);

const ROUTES = [
  ["landing", "/#/"],
  ["landing-signed-in", "/?demo#/"],
  ["worlds", "/?demo#/worlds/minecraft"],
  ["worlds-factorio", "/?demo#/worlds/factorio"],
  ["world", "/?demo#/worlds/minecraft/minecraft-rostik-12345678"],
  ["world-vanilla", "/?demo#/worlds/minecraft/vanilla"],
  ["releases", "/?demo#/releases/minecraft"],
  ["console", "/?demo#/console/minecraft"],
  ["metrics", "/?demo#/metrics/minecraft"],
  ["access-users", "/?demo#/access/users"],
  ["access-roles", "/?demo#/access/roles"],
  ["access-notifications", "/?demo#/access/notifications"],
  ["profile", "/?demo#/profile"],
];

const VIEWPORTS = [
  [360, 780, true],
  [390, 844, true],
  [599, 900, true],
  [768, 1024, true],
  [960, 900, false],
  [1279, 900, false],
  [1440, 900, false],
  [1920, 1080, false],
];

const PROBE = String.raw`(() => {
  const toRgb = (value) => {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  const path = (el) => {
    const bits = [];
    let node = el;
    for (let i = 0; node && i < 4; i += 1) {
      const cls = typeof node.className === "string" && node.className ? "." + node.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
      bits.unshift(node.tagName.toLowerCase() + cls);
      node = node.parentElement;
    }
    return bits.join(" > ");
  };
  const visible = (el, rect) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    if (rect.width < 1 || rect.height < 1) return false;
    if (el.closest("[hidden]")) return false;
    return true;
  };
  const scrollableAncestor = (el) => {
    let node = el.parentElement;
    while (node) {
      const cs = getComputedStyle(node);
      if (cs.overflowX === "auto" || cs.overflowX === "scroll") return true;
      node = node.parentElement;
    }
    return false;
  };
  const effectiveBg = (el) => {
    let node = el;
    while (node) {
      const c = toRgb(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.95) return c;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const all = Array.from(document.querySelectorAll("body *"));
  const result = {
    docScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    overflowing: [], clipped: [], smallTargets: [], fonts: {}, radii: {}, zIndex: {},
    contrast: [], shadows: [], fontFamilies: {},
  };

  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (!visible(el, rect)) continue;
    const cs = getComputedStyle(el);

    // 1. Horizontal overflow past the viewport, with no scroll container to excuse it.
    if ((rect.right > window.innerWidth + 1 || rect.left < -1) && !scrollableAncestor(el)) {
      result.overflowing.push({ sel: path(el), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) });
    }

    // 2. Content cut off with no ellipsis to announce it.
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX === "hidden" && cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.textContent.trim()) {
      result.clipped.push({ sel: path(el), scroll: el.scrollWidth, client: el.clientWidth, text: el.textContent.trim().slice(0, 40) });
    }

    // 3. Touch targets.
    const interactive = el.matches("button, a[href], input, select, textarea, [role=menuitem], [role=tab], summary");
    if (interactive && (rect.width < 32 || rect.height < 32) && cs.display !== "contents") {
      result.smallTargets.push({ sel: path(el), w: Math.round(rect.width), h: Math.round(rect.height), label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30) });
    }

    // 4. Type ramp: only elements that own text directly.
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText) {
      const key = cs.fontSize + "/" + cs.lineHeight + "/" + cs.fontWeight;
      (result.fonts[key] ||= { count: 0, samples: [] });
      result.fonts[key].count += 1;
      if (result.fonts[key].samples.length < 3) result.fonts[key].samples.push(path(el));
      const fam = cs.fontFamily.split(",")[0].replace(/["']/g, "");
      (result.fontFamilies[fam] ||= { count: 0, samples: [] });
      result.fontFamilies[fam].count += 1;
      if (result.fontFamilies[fam].samples.length < 3) result.fontFamilies[fam].samples.push(path(el));

      // 5. Contrast of real text against its effective background.
      const fg = toRgb(cs.color);
      if (fg) {
        const bg = effectiveBg(el);
        const composite = fg.a < 1 ? over(fg, bg) : fg;
        const r = ratio(composite, bg);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        if (r < (large ? 3 : 4.5)) result.contrast.push({ sel: path(el), ratio: Math.round(r * 100) / 100, size: cs.fontSize, color: cs.color, bg: "rgb(" + Math.round(bg.r) + "," + Math.round(bg.g) + "," + Math.round(bg.b) + ")", text: (el.textContent || "").trim().slice(0, 30) });
      }
    }

    // 6. Radius and z-index vocabularies.
    if (cs.borderRadius !== "0px") {
      (result.radii[cs.borderRadius] ||= { count: 0, samples: [] });
      result.radii[cs.borderRadius].count += 1;
      if (result.radii[cs.borderRadius].samples.length < 3) result.radii[cs.borderRadius].samples.push(path(el));
    }
    if (cs.zIndex !== "auto") {
      (result.zIndex[cs.zIndex] ||= { count: 0, samples: [] });
      result.zIndex[cs.zIndex].count += 1;
      if (result.zIndex[cs.zIndex].samples.length < 3) result.zIndex[cs.zIndex].samples.push(path(el));
    }

    // 7. Shadow on a persistent surface.
    if (cs.boxShadow !== "none" && !el.matches(".menu, .dialog, .sheet, .snackbar, .switch-track, .switch-track::after, .drawer, .btn-filled, .mark")) {
      result.shadows.push({ sel: path(el), shadow: cs.boxShadow.slice(0, 60) });
    }
  }
  return JSON.stringify(result);
})()`;

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), "audit-"));
const port = randomInt(9600, 9900);
const proc = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--hide-scrollbars", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error("chrome did not start");
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let nextId = 0;
const pending = new Map();
let onLoad = null;
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  else if (message.method === "Page.loadEventFired" && onLoad) onLoad();
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const findings = [];
let pass = 0;
try {
  await send("Page.enable");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("spawnpoint.theme", ${JSON.stringify(scheme)}); } catch (e) {}` });

  for (const [width, height, mobile] of VIEWPORTS) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
    for (const [name, route] of ROUTES) {
      // A hash-only change reuses the document and never fires a load event, so
      // every probe gets a unique query parameter and a timeout to fall back on.
      pass += 1;
      const joiner = route.includes("?") ? "&" : "?";
      const [path, hash = ""] = route.split("#");
      const url = `${base}${path}${joiner}probe=${pass}${hash ? "#" + hash : ""}`;
      const loaded = new Promise((r) => { onLoad = r; });
      await send("Page.navigate", { url });
      await Promise.race([loaded, sleep(8000)]);
      await sleep(600);
      const probe = await send("Runtime.evaluate", { expression: PROBE, returnByValue: true, awaitPromise: false });
      const raw = probe.result?.result?.value;
      if (!raw) { findings.push({ route: name, width, error: JSON.stringify(probe.result).slice(0, 300) }); continue; }
      findings.push({ route: name, width, mobile, ...JSON.parse(raw) });
    }
  }
  writeFileSync(out, JSON.stringify(findings, null, 1));
  console.log(`wrote ${out}: ${findings.length} probes`);
} finally {
  ws.close();
  proc.kill();
}
