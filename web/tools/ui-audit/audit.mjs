// Runtime UI audit: every route, state and width, probed in the page.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { launch, sleep } from "./cdp.mjs";
import { STATES } from "./states.mjs";

// usage: audit.mjs [--gate] [--advise] [--accept] [--self-test] [base-url]
//
// --gate      the blocking check CI runs: fails on a finding accepted.txt does not list.
// --advise    adds the advisory checks and writes the report with a screenshot per finding.
// --accept    prints accepted.txt lines for what this run found; a reason is added by hand.
// --self-test runs the probe on the fixtures in fixtures/ and fails on a miss it should catch.
//
// While fixing, narrow a run: SKIN=cloud AUDIT_ROUTES=world,worlds AUDIT_WIDTHS=360,600
// AUDIT_STATES=stop AUDIT_STRIDE=0. AUDIT_OUT names the report folder (default out/ui-audit).
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const gate = flags.has("--gate");
const advise = flags.has("--advise");
const accept = flags.has("--accept");
const selfTest = flags.has("--self-test");
const [base = "http://127.0.0.1:5173"] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const here = dirname(fileURLToPath(import.meta.url));
const accepted = join(here, "accepted.txt");
const reportDir = resolve(process.env.AUDIT_OUT ?? join(here, "../../out/ui-audit"));
const PROBE_SOURCE = readFileSync(join(here, "probe.js"), "utf8");

// The faces CI gates. The old console skin is not gated: S9 deletes it.
const SKINS = process.env.SKIN ? process.env.SKIN.split(",") : ["cloud", "terminal"];

const ROUTES = [
  ["landing", "/#/"],
  ["landing-signed-in", "/?demo&latency=0#/"],
  ["worlds", "/?demo&latency=0#/worlds/minecraft"],
  ["worlds-factorio", "/?demo&latency=0#/worlds/factorio"],
  ["world", "/?demo&latency=0#/worlds/minecraft/minecraft-rostik-12345678"],
  ["world-wipes", "/?demo&latency=0#/worlds/minecraft/minecraft-rostik-12345678/wipes"],
  ["world-backups", "/?demo&latency=0#/worlds/minecraft/minecraft-rostik-12345678/backups"],
  ["world-releases", "/?demo&latency=0#/worlds/minecraft/minecraft-rostik-12345678/releases"],
  ["world-whitelist", "/?demo&latency=0#/worlds/minecraft/minecraft-rostik-12345678/whitelist"],
  ["world-console", "/?demo&latency=0#/worlds/minecraft/minecraft-rostik-12345678/console"],
  ["world-metrics", "/?demo&latency=0#/worlds/minecraft/minecraft-rostik-12345678/metrics"],
  ["world-factorio", "/?demo&latency=0#/worlds/factorio/factorio"],
  ["world-vanilla", "/?demo&latency=0#/worlds/minecraft/vanilla"],
  ["releases", "/?demo&latency=0#/releases/minecraft"],
  ["access-users", "/?demo&latency=0#/access/users"],
  ["access-roles", "/?demo&latency=0#/access/roles"],
  ["access-notifications", "/?demo&latency=0#/access/notifications"],
  ["profile", "/?demo&latency=0#/profile"],
];

// Both sides of every step in web/DESIGN.md (599/600, 839/840, 959/960,
// 1199/1200), the smallest phone, a desktop and a 4K screen at 150%.
const PAGE_WIDTHS = [360, 599, 600, 839, 840, 959, 960, 1199, 1200, 1440, 2560];
// Dialogs dock to the bottom at the Compact step.
const OVERLAY_WIDTHS = [360, 599, 600, 1440, 2560];
const DARK_WIDTHS = [360, 1440];
const STRESS_WIDTHS = [360, 840, 1440];
// A table changes layout at its container's width, not the viewport's: a 40px
// stride finds what falls between the steps. Light only, resized in place.
const STRIDE = process.env.AUDIT_STRIDE === "0" ? [] : Array.from({ length: 34 }, (_, i) => 360 + i * 40);
const heightOf = (width) => (width >= 2560 ? 1440 : width >= 1920 ? 1080 : width >= 960 ? 900 : width >= 600 ? 1024 : 844);
const mobileAt = (width) => width < 960;

const onlyRoutes = process.env.AUDIT_ROUTES ? new Set(process.env.AUDIT_ROUTES.split(",")) : null;
const onlyWidths = process.env.AUDIT_WIDTHS ? new Set(process.env.AUDIT_WIDTHS.split(",").map(Number)) : null;
const onlyStates = process.env.AUDIT_STATES !== undefined ? new Set(process.env.AUDIT_STATES.split(",").filter(Boolean)) : null;
const widthOk = (width) => !onlyWidths || onlyWidths.has(width);

// Selectors for faces that do not emit layout markers. The cloud skin's
// primitives emit data-layout, data-col, data-status and data-layer, and the
// probe reads those; these lists hold the terminal skin to the same promises.
const LAYOUT = {
  oneLine: [[".t-page-head", 600]],
  pairs: [".t-detail"],
  rails: {
    containers: ".t-panel",
    starts: [".t-filter-row .t-field", ".t-table th:first-child", ".t-table tr:not(.t-table-state) > td:first-child", ".t-detail > dt"],
  },
  centred: [".t-empty"],
};

// What fails the gate. The rest is the advisory report.
const KINDS = {
  wider: "page wider than the screen",
  overflowing: "past the screen edge",
  sideways: "scrolls sideways",
  overlaps: "box over box",
  textOverText: "text over text",
  wrapped: "row broke its line",
  offCentre: "empty state off centre",
  misaligned: "label off its value",
  offRail: "start off the card edge",
  menuClipped: "menu label cut",
  menuRagged: "menu labels ragged",
  menuCut: "menu past the screen",
  packed: "row packed at one side",
  columns: "columns not shared",
  repeatedLabel: "label in every row",
  iconOffLine: "icon off the text centreline",
  crumbRepeat: "title said twice",
  gridEdge: "grid short of its edge",
  cardHeights: "cards of one row differ in height",
  stateTwice: "state said twice",
  error: "probe or state failed",
};
const ADVISORY = {
  loosePacked: "content packed at one side",
  copy: "explanatory copy",
  stretched: "stretched card",
  smallTargets: "target below the floor",
  contrast: "contrast below 4.5",
  clipped: "cut with no ellipsis",
};

// ---- Jobs ------------------------------------------------------------------

function plan() {
  const jobs = [];
  const routes = ROUTES.filter(([name]) => !onlyRoutes || onlyRoutes.has(name));
  for (const skin of SKINS) {
    for (const [name, route] of routes) {
      for (const width of PAGE_WIDTHS.filter(widthOk)) {
        jobs.push({ type: "page", skin, name, route, width, theme: "light", menus: OVERLAY_WIDTHS.includes(width) });
        if (DARK_WIDTHS.includes(width)) jobs.push({ type: "page", skin, name, route, width, theme: "dark", menus: false });
        if (STRESS_WIDTHS.includes(width) && name !== "landing") jobs.push({ type: "page", skin, name: `${name}+stress`, route: route.replace("?demo", "?demo&fixture=stress"), width, theme: "light", menus: false });
      }
      const stride = STRIDE.filter((width) => widthOk(width) && !PAGE_WIDTHS.includes(width));
      for (const mobile of [true, false]) {
        const widths = stride.filter((width) => mobileAt(width) === mobile);
        if (widths.length > 0 && name !== "landing") jobs.push({ type: "stride", skin, name, route, widths, theme: "light" });
      }
    }
    for (const state of STATES) {
      if (state.skins && !state.skins.includes(skin)) continue;
      if (onlyStates && !onlyStates.has(state.name)) continue;
      if (onlyRoutes && !onlyStates) continue;
      for (const width of OVERLAY_WIDTHS.filter(widthOk)) {
        jobs.push({ type: "state", skin, name: `state:${state.name}`, state, route: state.route, width, theme: "light" });
        if (DARK_WIDTHS.includes(width)) jobs.push({ type: "state", skin, name: `state:${state.name}`, state, route: state.route, width, theme: "dark" });
      }
    }
  }
  // Long jobs first, so the workers finish together.
  return jobs.sort((a, b) => (b.type === "stride") - (a.type === "stride"));
}

// ---- In-page helpers ---------------------------------------------------------

// Fonts loaded, then animations finished (a spinner's endless loop excepted),
// then two frames. Bounded, so a page that never settles is still measured.
const SETTLE = `(async () => {
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  const until = performance.now() + 1500;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  while (performance.now() < until) {
    const running = document.getAnimations().filter((a) => a.playState === "running" && a.effect && a.effect.getTiming().iterations !== Infinity);
    if (running.length === 0) break;
    await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 100))]);
  }
  await frame(); await frame();
  return true;
})()`;

// The surfaces open now: their elements, tagged so the probe can find them.
const SURFACES = `(() => {
  const open = [];
  const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[hidden]"); };
  for (const el of document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [role=menu], [role=tooltip], #c-tip, .c-toast, .t-toast, .snackbar")) if (shown(el)) open.push(el);
  return open;
})()`;

const STEP = `(async (step) => {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const first = (selector) => Array.from(document.querySelectorAll(selector)).find(shown) ?? null;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (step.click) { const el = first(step.click); if (!el) return "absent"; el.scrollIntoView({ block: "center" }); el.click(); return "ok"; }
  if (step.focus) { const el = first(step.focus); if (!el) return "absent"; el.scrollIntoView({ block: "center" }); el.focus(); el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); return "ok"; }
  if (step.key) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: step.key, bubbles: true })); window.dispatchEvent(new KeyboardEvent("keydown", { key: step.key, bubbles: true })); return "ok"; }
  if (step.action) {
    const all = Array.from(document.querySelectorAll("[data-action='" + step.action + "']"));
    const direct = all.find((el) => shown(el) && !el.closest("[role=menu]"));
    if (direct) { direct.scrollIntoView({ block: "center" }); direct.click(); return "ok"; }
    for (const item of all) {
      const menu = item.closest("[role=menu]");
      const trigger = menu && menu.id ? Array.from(document.querySelectorAll("[aria-controls]")).find((el) => el.getAttribute("aria-controls") === menu.id && shown(el)) : null;
      if (!trigger) continue;
      trigger.scrollIntoView({ block: "center" });
      trigger.click();
      await wait(250);
      item.click();
      return "ok";
    }
    return "absent";
  }
  return "unknown step";
})`;

// ---- Running a job ---------------------------------------------------------

async function settle(tab) {
  await tab.evaluate(SETTLE, true).catch(() => undefined);
}

async function setWidth(tab, width) {
  await tab.send("Emulation.setDeviceMetricsOverride", { width, height: heightOf(width), deviceScaleFactor: 1, mobile: mobileAt(width) });
  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: mobileAt(width), maxTouchPoints: mobileAt(width) ? 5 : 0 });
}

let pass = 0;
async function open(tab, job, width) {
  await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: job.theme }] });
  await setWidth(tab, width);
  // A hash-only change reuses the document and fires no load event: a unique
  // query parameter makes every visit a fresh load.
  pass += 1;
  const [path, hash = ""] = job.route.split("#");
  const joiner = path.includes("?") ? "&" : "?";
  await tab.goto(`${base}${path}${joiner}probe=${pass}&skin=${encodeURIComponent(job.skin)}${hash ? "#" + hash : ""}`);
  await settle(tab);
}

async function probe(tab, width, root = null) {
  const options = { width, coarse: mobileAt(width), layout: LAYOUT, advise, root };
  return tab.evaluate(`(${PROBE_SOURCE})(${JSON.stringify(options)})`);
}

// Opens every menu on the page in turn and measures it on its own.
async function walkMenus(tab, width) {
  const results = [];
  const count = await tab.evaluate(`(() => {
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[hidden], dialog:not([open])"); };
    const triggers = Array.from(document.querySelectorAll("[aria-haspopup=menu][aria-controls]")).filter((el) => shown(el) && el.getAttribute("aria-disabled") !== "true" && !el.disabled);
    triggers.forEach((el, i) => el.setAttribute("data-audit-trigger", String(i)));
    return triggers.length;
  })()`);
  for (let i = 0; i < count; i += 1) {
    const label = await tab.evaluate(`(() => {
      const trigger = document.querySelector("[data-audit-trigger='${i}']");
      if (!trigger) return null;
      document.querySelectorAll("[data-audit-root]").forEach((el) => el.removeAttribute("data-audit-root"));
      trigger.scrollIntoView({ block: "center" });
      trigger.click();
      const menu = document.getElementById(trigger.getAttribute("aria-controls"));
      if (menu) menu.setAttribute("data-audit-root", "");
      return trigger.getAttribute("aria-label") || trigger.textContent.trim();
    })()`);
    if (label === null) continue;
    await settle(tab);
    const found = await probe(tab, width, "[data-audit-root]");
    results.push({ label, found });
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await tab.evaluate(`(() => {
      const trigger = document.querySelector("[data-audit-trigger='${i}']");
      const menu = trigger && document.getElementById(trigger.getAttribute("aria-controls"));
      if (menu && !menu.hidden && menu.getBoundingClientRect().width > 0) trigger.click();
      window.scrollTo(0, 0);
    })()`);
    await settle(tab);
  }
  return results;
}

async function runState(tab, job) {
  // A fixture is open already; a route is opened here.
  if (job.route) await open(tab, job, job.width);
  const before = await tab.evaluate(`${SURFACES}.length`);
  for (const step of job.state.steps) {
    const outcome = await tab.evaluate(`${STEP}(${JSON.stringify(step)})`, true);
    // A control a width does not show cannot be pressed there: not a finding.
    if (outcome === "absent") return null;
    if (outcome !== "ok") return { error: `step ${JSON.stringify(step)}: ${outcome}` };
    await settle(tab);
  }
  const opened = await tab.evaluate(`(() => {
    const open = ${SURFACES};
    document.querySelectorAll("[data-audit-root]").forEach((el) => el.removeAttribute("data-audit-root"));
    const top = open.at(-1);
    if (!top || open.length <= ${before}) return false;
    top.setAttribute("data-audit-root", "");
    return true;
  })()`);
  if (!opened) return { error: "the state opened no surface" };
  return { found: await probe(tab, job.width, "[data-audit-root]") };
}

// One record per probe: what it measured and where.
function record(job, width, found, extra = {}) {
  return { skin: job.skin, name: job.name, width, theme: job.theme, ...extra, found };
}

async function runJob(tab, job, records) {
  try {
    if (job.type === "page") {
      await open(tab, job, job.width);
      records.push(record(job, job.width, await probe(tab, job.width)));
      if (job.menus) {
        for (const menu of await walkMenus(tab, job.width)) records.push(record({ ...job, name: `${job.name} menu` }, job.width, menu.found, { menu: menu.label }));
      }
    } else if (job.type === "stride") {
      await open(tab, job, job.widths[0]);
      for (const width of job.widths) {
        await setWidth(tab, width);
        await settle(tab);
        records.push(record({ ...job, name: `${job.name}` }, width, await probe(tab, width), { stride: true }));
      }
    } else {
      const result = await runState(tab, job);
      if (result?.error) records.push(record(job, job.width, { error: [{ key: "state", sel: job.state.name, by: result.error }] }));
      else if (result) records.push(record(job, job.width, result.found));
    }
  } catch (error) {
    records.push(record(job, job.width ?? job.widths?.[0], { error: [{ key: "probe", sel: job.route, by: String(error.message ?? error).slice(0, 160) }] }));
  }
}

// ---- Keys, acceptance and the report ---------------------------------------

// One line per finding, stable across runs and class renames: skin, page or
// state, width, theme, kind and the element's markers.
const keyOf = (r, kind, item) => `${r.skin} ${r.name.replace(/ /g, "_")} ${r.width} ${r.theme} ${kind} ${item.key}`;

function findings(records, kinds) {
  const list = [];
  for (const r of records) for (const kind of Object.keys(kinds)) for (const item of r.found?.[kind] ?? []) list.push({ key: keyOf(r, kind, item), kind, record: r, item });
  const seenKeys = new Set();
  return list.filter((f) => !seenKeys.has(f.key) && seenKeys.add(f.key));
}

// accepted.txt: `skin page width theme kind marker  # reason`. `*` matches any
// skin, page, width or theme. A line without a reason is refused.
function readAccepted() {
  if (!existsSync(accepted)) return { rules: [], problems: [] };
  const rules = [];
  const problems = [];
  for (const [index, raw] of readFileSync(accepted, "utf8").split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, reason = ""] = line.split(/\s+#\s+/, 2);
    if (!reason.trim()) { problems.push(`accepted.txt:${index + 1}: no reason after " # "`); continue; }
    const [skin, page, width, theme, kind, ...marker] = pattern.trim().split(/\s+/);
    rules.push({ line: pattern.trim(), skin, page, width, theme, kind, marker: marker.join(" "), used: false });
  }
  return { rules, problems };
}

const wild = (rule, value) => rule === "*" || rule === String(value);
function acceptedBy(rules, f) {
  const [skin, page, width, theme, kind, ...marker] = f.key.split(" ");
  return rules.find((rule) => wild(rule.skin, skin) && wild(rule.page, page) && wild(rule.width, width) && wild(rule.theme, theme) && rule.kind === kind && rule.marker === marker.join(" "));
}

function line(f, kinds) {
  const r = f.record;
  const what = r.menu ? `menu “${r.menu}”: ${f.item.sel}` : f.item.sel;
  return `  ${r.skin.padEnd(8)} ${r.name.padEnd(28)} ${String(r.width).padStart(4)} ${r.theme.padEnd(5)} ${kinds[f.kind].padEnd(30)} ${String(f.item.by ?? f.item.text ?? "").slice(0, 36).padEnd(36)} ${String(what).slice(-70)}`;
}

// Draws each finding's box on the page it came from and keeps the picture.
async function shoot(tab, list, prefix) {
  const shots = new Map();
  const byPage = new Map();
  for (const f of list) {
    const r = f.record;
    const id = `${r.skin}|${r.name}|${r.width}|${r.theme}`;
    if (!byPage.has(id)) byPage.set(id, []);
    byPage.get(id).push(f);
  }
  let count = 0;
  for (const [id, group] of byPage) {
    if (count >= 120) break;
    count += 1;
    const r = group[0].record;
    const routeName = r.name.replace(/\+stress$/, "").replace(/ menu$/, "");
    const route = ROUTES.find(([name]) => name === routeName)?.[1] ?? STATES.find((s) => `state:${s.name}` === routeName)?.route;
    if (!route) continue;
    const job = { skin: r.skin, theme: r.theme, route: r.name.includes("+stress") ? route.replace("?demo", "?demo&fixture=stress") : route };
    try {
      await open(tab, job, r.width);
      const state = STATES.find((s) => `state:${s.name}` === routeName);
      if (state) for (const step of state.steps) { await tab.evaluate(`${STEP}(${JSON.stringify(step)})`, true); await settle(tab); }
      const boxes = group.map((f) => f.item.box).filter(Boolean);
      await tab.evaluate(`(() => {
        const layer = document.createElement("div");
        layer.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:2147483647";
        for (const b of ${JSON.stringify(boxes)}) {
          const mark = document.createElement("div");
          mark.style.cssText = "position:absolute;outline:2px solid #e00;outline-offset:1px;background:rgba(255,0,0,.08)";
          Object.assign(mark.style, { left: (b.x + scrollX) + "px", top: (b.y + scrollY) + "px", width: b.w + "px", height: b.h + "px" });
          layer.appendChild(mark);
        }
        (document.querySelector("dialog[open]") ?? document.body).appendChild(layer);
      })()`);
      const png = await tab.screenshot();
      if (!png) continue;
      const file = `${prefix}-${id.replace(/[^a-z0-9+]+/gi, "-")}.png`;
      writeFileSync(join(reportDir, file), png);
      for (const f of group) shots.set(f.key, file);
    } catch { /* a picture is a convenience; the finding stands without it */ }
  }
  return shots;
}

function writeReport(blocking, advisory, shots, summary) {
  const rows = (list, kinds) => list.map((f) => `| ${f.record.skin} | ${f.record.name}${f.record.menu ? ` (${f.record.menu})` : ""} | ${f.record.width} | ${f.record.theme} | ${kinds[f.kind]} | ${String(f.item.by ?? f.item.text ?? "").replace(/\|/g, "/")} | \`${f.item.key}\` | ${shots.has(f.key) ? `[shot](${shots.get(f.key)})` : ""} |`).join("\n");
  const head = "| Skin | Page or state | Width | Theme | Finding | Measure | Marker | Screenshot |\n|---|---|---|---|---|---|---|---|";
  writeFileSync(join(reportDir, "report.md"), [
    "# UI audit report", "", summary, "",
    `## Blocking (${blocking.length})`, "", blocking.length ? `${head}\n${rows(blocking, KINDS)}` : "None.", "",
    `## Advisory (${advisory.length})`, "", "A reviewer judges these; they do not fail the gate.", "", advisory.length ? `${head}\n${rows(advisory, ADVISORY)}` : "None.", "",
  ].join("\n"));
  writeFileSync(join(reportDir, "report.json"), JSON.stringify({ blocking: blocking.map(({ record, ...f }) => ({ ...f, skin: record.skin, name: record.name, width: record.width, theme: record.theme })), advisory: advisory.map(({ record, ...f }) => ({ ...f, skin: record.skin, name: record.name, width: record.width, theme: record.theme })) }, null, 1));
}

// ---- Self-test ---------------------------------------------------------------

// Each fixture reproduces one miss of the old gate; the probe must name it.
async function runSelfTest(browser) {
  const { FIXTURES } = await import("./fixtures/fixtures.mjs");
  const tab = await browser.open();
  let failed = 0;
  for (const fixture of FIXTURES) {
    const job = { theme: "light" };
    await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: job.theme }] });
    const records = [];
    for (const width of fixture.widths) {
      await setWidth(tab, width);
      await tab.goto(pathToFileURL(join(here, "fixtures", fixture.file)).href);
      await settle(tab);
      if (fixture.state) {
        const result = await runState(tab, { skin: "fixture", route: null, width, theme: "light", state: fixture.state, name: fixture.file }).catch((error) => ({ error: String(error) }));
        records.push({ width, found: result?.found ?? { error: [{ key: "state", by: result?.error ?? "absent" }] } });
      } else {
        records.push({ width, found: await probe(tab, width) });
        if (fixture.menus) for (const menu of await walkMenus(tab, width)) records.push({ width, found: menu.found });
      }
    }
    const kinds = (records.flatMap((r) => Object.entries(r.found).filter(([, items]) => items.length > 0).map(([kind]) => kind)));
    const missing = fixture.expect.filter((kind) => !kinds.includes(kind));
    const unwanted = (fixture.clean ?? []).filter((kind) => kinds.includes(kind));
    const ok = missing.length === 0 && unwanted.length === 0;
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${fixture.miss.padEnd(4)} ${fixture.file.padEnd(28)} expects ${fixture.expect.join(", ")}${missing.length ? `; missed ${missing.join(", ")}` : ""}${unwanted.length ? `; false ${unwanted.join(", ")}` : ""}`);
  }
  console.log(failed === 0 ? `self-test: ${FIXTURES.length} fixtures, every miss caught` : `self-test: ${failed} of ${FIXTURES.length} fixtures failed`);
  return failed === 0 ? 0 : 1;
}

// ---- Main --------------------------------------------------------------------

const started = Date.now();
const browser = await launch();
try {
  if (selfTest) {
    process.exitCode = await runSelfTest(browser);
  } else {
    mkdirSync(reportDir, { recursive: true });
    const jobs = plan();
    const workers = Math.max(1, Number(process.env.AUDIT_WORKERS ?? Math.min(4, availableParallelism())));
    const tabs = await Promise.all(Array.from({ length: workers }, () => browser.open()));
    const records = [];
    let next = 0;
    await Promise.all(tabs.map(async (tab) => {
      while (next < jobs.length) {
        const job = jobs[next];
        next += 1;
        await runJob(tab, job, records);
      }
    }));
    const probes = records.length;
    if (process.env.AUDIT_JSON) writeFileSync(process.env.AUDIT_JSON, JSON.stringify(records, null, 1));
    const blocking = findings(records, KINDS);
    const advisory = advise ? findings(records, ADVISORY) : [];
    const { rules, problems } = readAccepted();
    const fresh = blocking.filter((f) => { const rule = acceptedBy(rules, f); if (rule) rule.used = true; return !rule; });
    const summary = `${probes} probes (${jobs.length} jobs, ${workers} tabs) in ${Math.round((Date.now() - started) / 1000)}s: ${SKINS.join(" and ")}; ${blocking.length} blocking findings, ${blocking.length - fresh.length} accepted${advise ? `, ${advisory.length} advisory` : ""}.`;
    console.log(summary);
    if (advise) {
      const shots = await shoot(tabs[0], [...fresh, ...advisory.filter((f) => f.item.box)].slice(0, 400), "shot");
      writeReport(fresh, advisory, shots, summary);
      console.log(`report: ${join(reportDir, "report.md")}`);
      for (const f of advisory) console.log(line(f, ADVISORY));
    }
    for (const problem of problems) console.log(problem);
    const unused = rules.filter((rule) => !rule.used);
    // A narrowed run does not see every finding, so it cannot call a line stale.
    const narrowed = onlyRoutes || onlyWidths || onlyStates || process.env.SKIN || process.env.AUDIT_STRIDE === "0";
    if (unused.length > 0 && !narrowed) console.log(`\n${unused.length} accepted lines no longer match; remove them from accepted.txt:\n${unused.map((rule) => `  ${rule.line}`).join("\n")}`);
    if (accept) {
      console.log(`\nlines for accepted.txt (add a reason after " # " to each):\n${fresh.map((f) => `${f.key}  # `).join("\n")}`);
    } else if (fresh.length > 0) {
      console.log(`\nbreakpoint gate: ${fresh.length} new findings`);
      for (const f of fresh) console.log(line(f, KINDS));
      console.log(`\nkeys:\n${fresh.map((f) => `  ${f.key}`).join("\n")}`);
    } else {
      console.log("\nbreakpoint gate: no new findings");
    }
    if (gate) process.exitCode = fresh.length > 0 || problems.length > 0 ? 1 : 0;
  }
} finally {
  browser.close();
}
