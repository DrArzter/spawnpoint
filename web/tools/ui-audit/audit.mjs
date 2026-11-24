// Runtime UI audit: every route, state and width, probed in the page.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { launch } from "./cdp.mjs";
import { STATES, WORLD } from "./states.mjs";

// usage: audit.mjs [--gate] [--advise] [--accept] [--self-test] [base-url]
//
// --gate      the blocking check CI runs: fails on a finding accepted.txt does not list.
// --advise    adds the advisory checks and writes the report with a screenshot per finding.
// --accept    prints accepted.txt lines for what this run found; a reason is added by hand.
// --self-test runs the probe on the fixtures in fixtures/ and fails on a miss it should catch.
//
// While fixing, narrow a run: SKIN=console AUDIT_ROUTES=world,worlds AUDIT_WIDTHS=360,600
// AUDIT_STATES=stop AUDIT_STRIDE=0. AUDIT_OUT names the report folder (default out/ui-audit).
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const gate = flags.has("--gate");
const advise = flags.has("--advise");
const accept = flags.has("--accept");
const selfTest = flags.has("--self-test");
const base = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "http://127.0.0.1:4173";
const here = dirname(fileURLToPath(import.meta.url));
const accepted = join(here, "accepted.txt");
const reportDir = resolve(process.env.AUDIT_OUT ?? join(here, "../../out/ui-audit"));
const PROBE_SOURCE = readFileSync(join(here, "probe.js"), "utf8");

// The faces CI gates.
const SKINS = process.env.SKIN ? process.env.SKIN.split(",") : ["console", "terminal"];

const FAILURE_BOX = { console: ".c-empty", terminal: ".t-notice" };

const ROUTES = [
  ["landing", "/#/"],
  ["landing-signed-in", "/?demo&latency=0#/"],
  ["home", "/?demo&latency=0#/home/minecraft"],
  ["worlds", "/?demo&latency=0#/worlds/minecraft"],
  ["worlds-factorio", "/?demo&latency=0#/worlds/factorio"],
  ["world", WORLD],
  ["world-wipes", `${WORLD}/wipes`],
  ["world-backups", `${WORLD}/backups`],
  ["world-releases", `${WORLD}/releases`],
  ["world-whitelist", `${WORLD}/whitelist`],
  ["world-config", `${WORLD}/config`],
  ["world-console", `${WORLD}/console`],
  ["world-log", `${WORLD}/log`],
  ["world-metrics", `${WORLD}/metrics`],
  ["world-factorio", "/?demo&latency=0#/worlds/factorio/factorio"],
  ["world-vanilla", "/?demo&latency=0#/worlds/minecraft/vanilla"],
  // A promotion held at one step, and one that failed with a long cause; a failure shows once the operation has left the snapshot, so the gate waits for its mark.
  ["world-progress", "/?demo&latency=0&operation=running#/worlds/minecraft/minecraft-creative-5e1c9a07"],
  ["world-failed", "/?demo&latency=0&operation=failed#/worlds/minecraft/minecraft-creative-5e1c9a07", { console: "[data-status=error]", terminal: ".t-state-error" }],
  // A call the URL fails as the API would (src/demo/flag.ts): a role without the permission, and an API that did not answer. The gate waits for the failure's own box.
  ["world-backups-forbidden", `/?demo&latency=0&failure=forbidden.backups#${WORLD.split("#")[1]}/backups`, FAILURE_BOX],
  ["world-backups-unavailable", `/?demo&latency=0&failure=unavailable.backups#${WORLD.split("#")[1]}/backups`, FAILURE_BOX],
  ["worlds-forbidden", "/?demo&latency=0&failure=forbidden.worlds#/worlds/minecraft", FAILURE_BOX],
  ["worlds-unavailable", "/?demo&latency=0&failure=unavailable.worlds#/worlds/minecraft", FAILURE_BOX],
  ["releases", "/?demo&latency=0#/releases/minecraft"],
  ["access-users", "/?demo&latency=0#/access/users"],
  ["access-roles", "/?demo&latency=0#/access/roles"],
  ["access-notifications", "/?demo&latency=0#/access/notifications"],
  ["profile", "/?demo&latency=0#/profile"],
];

// Both sides of the steps where the frame, tables and dialogs change: the
// console's (759/760, 1023/1024, 1199/1200) and the terminal's (599/600,
// 839/840, 959/960); the smallest phone, a desktop and a 4K screen at 150%.
// The stride crosses the smaller steps up to 1680; 2560 shows the rest.
const PAGE_WIDTHS = [360, 599, 600, 759, 760, 839, 840, 959, 960, 1023, 1024, 1199, 1200, 1440, 2560];
// Dialogs dock to the bottom under 760px (console) and 600px (terminal).
const OVERLAY_WIDTHS = [360, 599, 600, 759, 760, 1440, 2560];
const DARK_WIDTHS = new Set([360, 1440]);
const STRESS_WIDTHS = new Set([360, 840, 1440]);
// A table changes layout at its container's width, not the viewport's: a 40px
// stride finds what falls between the steps. Light only, resized in place.
const STRIDE = process.env.AUDIT_STRIDE === "0" ? [] : Array.from({ length: 34 }, (_, i) => 360 + i * 40);
function heightOf(width) {
  if (width >= 2560) return 1440;
  if (width >= 1920) return 1080;
  if (width >= 960) return 900;
  return width >= 600 ? 1024 : 844;
}
const mobileAt = (width) => width < 960;

const onlyRoutes = process.env.AUDIT_ROUTES ? new Set(process.env.AUDIT_ROUTES.split(",")) : null;
const onlyWidths = process.env.AUDIT_WIDTHS ? new Set(process.env.AUDIT_WIDTHS.split(",").map(Number)) : null;
const onlyStates = process.env.AUDIT_STATES !== undefined ? new Set(process.env.AUDIT_STATES.split(",").filter(Boolean)) : null;
const widthOk = (width) => !onlyWidths || onlyWidths.has(width);

// Selectors for faces that do not emit layout markers. The console skin's
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
  covered: "floating layer under a dialog",
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

// The page at each width of the set: light, dark where listed, stress data where listed.
function pageJobs(skin, name, route) {
  const jobs = [];
  for (const width of PAGE_WIDTHS.filter(widthOk)) {
    jobs.push({ type: "page", skin, name, route, width, theme: "light", menus: OVERLAY_WIDTHS.includes(width) });
    if (DARK_WIDTHS.has(width)) jobs.push({ type: "page", skin, name, route, width, theme: "dark", menus: false });
    if (STRESS_WIDTHS.has(width) && name !== "landing") jobs.push({ type: "page", skin, name: `${name}+stress`, route: route.replace("?demo", "?demo&fixture=stress"), width, theme: "light", menus: false });
  }
  return jobs;
}

// The widths between the steps, resized in place: one job for phones, one for the rest.
function strideJobs(skin, name, route) {
  if (name === "landing") return [];
  const stride = STRIDE.filter((width) => widthOk(width) && !PAGE_WIDTHS.includes(width));
  return [true, false]
    .map((mobile) => ({ type: "stride", skin, name, route, widths: stride.filter((width) => mobileAt(width) === mobile), theme: "light" }))
    .filter((job) => job.widths.length > 0);
}

function stateJobs(skin) {
  const jobs = [];
  for (const state of STATES) {
    if (state.skins && !state.skins.includes(skin)) continue;
    if (onlyStates && !onlyStates.has(state.name)) continue;
    if (onlyRoutes && !onlyStates) continue;
    for (const width of OVERLAY_WIDTHS.filter(widthOk)) {
      jobs.push({ type: "state", skin, name: `state:${state.name}`, state, route: state.route, width, theme: "light" });
      if (DARK_WIDTHS.has(width)) jobs.push({ type: "state", skin, name: `state:${state.name}`, state, route: state.route, width, theme: "dark" });
    }
  }
  return jobs;
}

function plan() {
  const jobs = [];
  const routes = ROUTES.filter(([name]) => !onlyRoutes || onlyRoutes.has(name));
  for (const skin of SKINS) {
    for (const [name, route] of routes) jobs.push(...pageJobs(skin, name, route), ...strideJobs(skin, name, route));
    jobs.push(...stateJobs(skin));
  }
  // Long jobs first, so the workers finish together.
  return jobs.sort((a, b) => (b.type === "stride") - (a.type === "stride"));
}

// ---- In-page helpers ---------------------------------------------------------

// Fonts loaded, then a page that has stopped changing: no finite animation
// running and no DOM change for `quiet` ms (120 after a load, when rows may
// still arrive; 40 after a resize or a menu), so rows are measured at rest.
// Bounded at 3s, so a page that never settles is still measured.
const SETTLE = `(async (quiet) => {
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  const until = performance.now() + 3000;
  let changed = performance.now();
  const observer = new MutationObserver(() => { changed = performance.now(); });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const running = () => document.getAnimations().filter((a) => a.playState === "running" && a.effect && a.effect.getTiming().iterations !== Infinity);
  while (performance.now() < until) {
    const busy = running();
    if (busy.length > 0) {
      await Promise.race([Promise.all(busy.map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 100))]);
      continue;
    }
    if (performance.now() - changed >= quiet) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  observer.disconnect();
  await frame(); await frame();
  return true;
})`;

// The surfaces open now: their elements, tagged so the probe can find them.
const SURFACES = `(() => {
  const open = [];
  const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[hidden]"); };
  for (const el of document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [role=menu], [role=tooltip], #c-tip, .c-toast, .snackbar")) if (shown(el)) open.push(el);
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

// A state with `onTop: ["tip", "toast"]` names layers that must show above the
// dialog it opened. document.elementFromPoint cannot tell: a modal makes the
// page outside it inert, and a hit test skips inert boxes, so a layer that
// really is above still answers with the dialog. The paint order of a DOM
// snapshot is the order the browser draws in, top layer included.
const MARK_LAYERS = `((kinds) => {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none"; };
  document.querySelectorAll("[data-layer=tip], [data-layer=menu], [data-layer=toast]").forEach((el) => el.setAttribute("data-audit-layer", el.dataset.layer));
  document.querySelectorAll("dialog:modal").forEach((el) => el.setAttribute("data-audit-modal", ""));
  const missing = [];
  for (const kind of kinds) {
    const layer = Array.from(document.querySelectorAll('[data-layer="' + kind + '"]')).find((el) => shown(el) && el.textContent.trim() !== "");
    const box = layer && ((kind === "toast" ? layer.firstElementChild : null) ?? layer);
    if (box) box.setAttribute("data-audit-box", kind); else missing.push(kind);
  }
  return missing;
})`;
const UNMARK_LAYERS = `document.querySelectorAll("[data-audit-layer], [data-audit-box], [data-audit-modal]").forEach((el) => { el.removeAttribute("data-audit-layer"); el.removeAttribute("data-audit-box"); el.removeAttribute("data-audit-modal"); })`;

// A layer is covered when an open modal paints after it, wherever it sits (the
// backdrop dims the whole page), or when any box that is no layer paints after
// it over its centre.
function coveredBy(snapshot) {
  const { documents, strings } = snapshot;
  const doc = documents[0];
  const attribute = (node, name) => {
    const list = doc.nodes.attributes[node];
    for (let i = 0; i < list.length; i += 2) {
      if (strings[list[i]] === name) return strings[list[i + 1]];
    }
    return null;
  };
  const parent = doc.nodes.parentIndex;
  const painted = new Map(doc.layout.nodeIndex.map((node, k) => [node, { order: doc.layout.paintOrders[k], box: doc.layout.bounds[k] }]));
  const inLayer = (node) => {
    for (let n = node; n >= 0; n = parent[n]) {
      if (attribute(n, "data-audit-layer") !== null) return true;
    }
    return false;
  };
  const found = [];
  for (const [node, { order, box }] of painted) {
    const kind = attribute(node, "data-audit-box");
    if (kind === null) continue;
    const x = box[0] + box[2] / 2;
    const y = box[1] + box[3] / 2;
    for (const [other, over] of painted) {
      if (over.order <= order || inLayer(other)) continue;
      const [left, top, width, height] = over.box;
      const modal = attribute(other, "data-audit-modal") !== null;
      if (!modal && (x < left || x > left + width || y < top || y > top + height)) continue;
      const name = strings[doc.nodes.nodeName[other]].toLowerCase();
      const css = (attribute(other, "class") ?? "").split(" ")[0];
      found.push({ key: "layer=" + kind, sel: kind + " layer", by: "under " + name + (css ? "." + css : "") });
      break;
    }
  }
  return found;
}

// ---- Running a job ---------------------------------------------------------

async function settle(tab, quiet = 120) {
  await tab.evaluate(`${SETTLE}(${quiet})`, true).catch(() => undefined);
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
  // The front door mounts after its own boot: wait for the app before the page settles.
  await tab.evaluate(`(async () => { const until = performance.now() + 5000; while (performance.now() < until && !document.getElementById("root")?.children.length) await new Promise((r) => setTimeout(r, 50)); })()`, true).catch(() => undefined);
  const ready = ROUTES.find(([, route]) => route === job.route.replace("?demo&fixture=stress", "?demo"))?.[2]?.[job.skin];
  if (ready) await tab.evaluate(`(async () => { const until = performance.now() + 8000; while (performance.now() < until && !document.querySelector(${JSON.stringify(ready)})) await new Promise((r) => setTimeout(r, 50)); })()`, true).catch(() => undefined);
  await settle(tab);
  // A blank page or another skin has nothing wrong to find: say so, or the gate passes on nothing.
  const worn = await tab.evaluate(`JSON.stringify({ mounted: (document.getElementById("root")?.children.length ?? 0) > 0, skin: document.documentElement.dataset.skin ?? null })`).then(JSON.parse);
  if (!worn.mounted) throw new Error(`the app did not render ${job.route}`);
  if (path.includes("demo") && worn.skin !== job.skin) throw new Error(`asked for skin ${job.skin}, the page wears ${worn.skin}`);
}

async function probe(tab, width, root = null) {
  const options = { width, coarse: mobileAt(width), layout: LAYOUT, advise, root };
  // probe.js declares helpers beside `probe`: it runs as one script, then `probe` is called.
  return tab.evaluate(`(() => {\n${PROBE_SOURCE}\nreturn probe(${JSON.stringify(options)});\n})()`);
}

// Opens the menu of one trigger; returns the trigger's label, or null when it is gone.
async function openMenu(tab, i) {
  return tab.evaluate(`(() => {
    const trigger = document.querySelector("[data-audit-trigger='${i}']");
    if (!trigger) return null;
    document.querySelectorAll("[data-audit-root]").forEach((el) => el.removeAttribute("data-audit-root"));
    trigger.scrollIntoView({ block: "center" });
    trigger.click();
    const menu = document.getElementById(trigger.getAttribute("aria-controls"));
    if (menu) menu.setAttribute("data-audit-root", "");
    return trigger.getAttribute("aria-label") || trigger.textContent.trim();
  })()`);
}

async function closeMenu(tab, i) {
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await tab.evaluate(`(() => {
    const trigger = document.querySelector("[data-audit-trigger='${i}']");
    const menu = trigger && document.getElementById(trigger.getAttribute("aria-controls"));
    if (menu && !menu.hidden && menu.getBoundingClientRect().width > 0) trigger.click();
    window.scrollTo(0, 0);
  })()`);
  await settle(tab, 40);
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
  // NOSONAR below: one menu is open at a time on one tab; the steps stay in order.
  for (let i = 0; i < count; i += 1) {
    const label = await openMenu(tab, i); // NOSONAR one tab, menus one at a time
    if (label === null) continue;
    await settle(tab, 40); // NOSONAR one tab, menus one at a time
    const found = await probe(tab, width, "[data-audit-root]"); // NOSONAR one tab, menus one at a time
    results.push({ label, found });
    await closeMenu(tab, i); // NOSONAR one tab, menus one at a time
  }
  return results;
}

async function runState(tab, job) {
  // A fixture is open already; a route is opened here.
  if (job.route) await open(tab, job, job.width);
  const before = await tab.evaluate(`${SURFACES}.length`);
  for (const step of job.state.steps) {
    const outcome = await tab.evaluate(`${STEP}(${JSON.stringify(step)})`, true); // NOSONAR steps run in order on one tab
    // A control a width does not show cannot be pressed there. The run
    // counts these and fails a state that is absent everywhere or at 1440.
    if (outcome === "absent") return { absent: true };
    if (outcome !== "ok") return { error: `step ${JSON.stringify(step)}: ${outcome}` };
    await settle(tab); // NOSONAR steps run in order on one tab
  }
  const opened = await tab.evaluate(`(() => {
    const open = ${SURFACES};
    document.querySelectorAll("[data-audit-root]").forEach((el) => el.removeAttribute("data-audit-root"));
    const top = ${job.state.onTop ? 'open.filter((el) => el.matches("dialog[open]")).at(-1)' : "open.at(-1)"};
    if (!top || open.length <= ${before}) return false;
    top.setAttribute("data-audit-root", "");
    return true;
  })()`);
  if (!opened) return { error: "the state opened no surface" };
  const found = await probe(tab, job.width, "[data-audit-root]");
  if (job.state.onTop) {
    const missing = await tab.evaluate(`${MARK_LAYERS}(${JSON.stringify(job.state.onTop)})`);
    const snapshot = await tab.send("DOMSnapshot.captureSnapshot", { computedStyles: [], includePaintOrder: true });
    await tab.evaluate(UNMARK_LAYERS);
    if (missing.length > 0) return { error: `no ${missing.join(" or ")} is showing` };
    if (!snapshot.result) return { error: "the paint order could not be read" };
    found.covered = coveredBy(snapshot.result);
  }
  return { found };
}

// One record per probe: what it measured and where.
function record(job, width, found, extra = {}) {
  return { skin: job.skin, name: job.name, width, theme: job.theme, ...extra, found };
}

async function probeAt(tab, width) {
  await setWidth(tab, width);
  await settle(tab, 40);
  return probe(tab, width);
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
        const found = await probeAt(tab, width); // NOSONAR one tab, resized in place, width by width
        records.push(record(job, width, found, { stride: true }));
      }
    } else {
      const result = await runState(tab, job);
      if (result.error) records.push(record(job, job.width, { error: [{ key: "state", sel: job.state.name, by: result.error }] }));
      else if (result.absent) records.push(record(job, job.width, {}, { absent: true }));
      else records.push(record(job, job.width, result.found));
    }
  } catch (error) {
    records.push(record(job, job.width ?? job.widths?.[0], { error: [{ key: "probe", sel: job.route, by: String(error.message ?? error).slice(0, 160) }] }));
  }
}

// ---- Keys, acceptance and the report ---------------------------------------

// One line per finding, stable across runs and class renames: skin, page or
// state, width, theme, kind and the element's markers.
const keyOf = (r, kind, item) => `${r.skin} ${r.name.replaceAll(" ", "_")} ${r.width} ${r.theme} ${kind} ${item.key}`;

function findings(records, kinds) {
  const list = [];
  for (const r of records) for (const kind of Object.keys(kinds)) for (const item of r.found?.[kind] ?? []) list.push({ key: keyOf(r, kind, item), kind, record: r, item });
  const seenKeys = new Set();
  return list.filter((f) => !seenKeys.has(f.key) && seenKeys.add(f.key));
}

// `pattern # reason`: the reason follows the first "#" that has a space on both sides.
function splitReason(line) {
  const at = line.search(/\s#\s/);
  return at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 3)];
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
    const [pattern, reason] = splitReason(line);
    if (!reason.trim()) { problems.push(`accepted.txt:${index + 1}: no reason after " # "`); continue; }
    const [skin, page, width, theme, kind, ...marker] = pattern.trim().split(/\s+/);
    // A line that names neither a page nor a precise element would hide every match of its kind.
    if (page === "*" && marker.join(" ").split(" ").length < 2) { problems.push(`accepted.txt:${index + 1}: a page "*" needs a marker of two parts or more`); continue; }
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
// The pages are shared out over every tab; at most 120 pictures.
async function shoot(tabs, list, prefix) {
  const shots = new Map();
  const byPage = new Map();
  for (const f of list) {
    const r = f.record;
    const id = `${r.skin}|${r.name}|${r.width}|${r.theme}`;
    if (!byPage.has(id)) byPage.set(id, []);
    byPage.get(id).push(f);
  }
  const pages = [...byPage].slice(0, 120);
  await Promise.all(tabs.map(async (tab, index) => {
    for (const page of pages.filter((_, at) => at % tabs.length === index)) await shootPage(tab, page, prefix, shots); // NOSONAR a tab shoots one page at a time
  }));
  return shots;
}

async function replaySteps(tab, steps) {
  for (const step of steps) {
    await tab.evaluate(`${STEP}(${JSON.stringify(step)})`, true); // NOSONAR steps run in order on one tab
    await settle(tab); // NOSONAR steps run in order on one tab
  }
}

async function shootPage(tab, [id, group], prefix, shots) {
  const r = group[0].record;
  const routeName = r.name.replace(/\+stress$/, "").replace(/ menu$/, "");
  const route = ROUTES.find(([name]) => name === routeName)?.[1] ?? STATES.find((s) => `state:${s.name}` === routeName)?.route;
  if (!route) return;
  const job = { skin: r.skin, theme: r.theme, route: r.name.includes("+stress") ? route.replace("?demo", "?demo&fixture=stress") : route };
  try {
    await open(tab, job, r.width);
    const state = STATES.find((s) => `state:${s.name}` === routeName);
    if (state) await replaySteps(tab, state.steps);
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
    if (!png) return;
    const file = `${prefix}-${id.replace(/[^a-z0-9+]+/gi, "-")}.png`;
    writeFileSync(join(reportDir, file), png);
    for (const f of group) shots.set(f.key, file);
  } catch { /* a picture is a convenience; the finding stands without it */ }
}

// One row per element and kind, with the pages and widths that show it.
function grouped(list) {
  const groups = new Map();
  for (const f of list) {
    const r = f.record;
    const id = `${r.skin} ${f.kind} ${f.item.key} ${String(f.item.text ?? "").slice(0, 30)}`;
    if (!groups.has(id)) groups.set(id, { first: f, pages: new Set(), widths: new Set(), keys: [] });
    const g = groups.get(id);
    g.pages.add(r.name + (r.menu ? ` (${r.menu})` : ""));
    g.widths.add(`${r.width}${r.theme === "dark" ? " dark" : ""}`);
    g.keys.push(f.key);
  }
  return [...groups.values()];
}

function writeReport(blocking, advisory, shots, summary) {
  const cell = (value) => String(value).replaceAll("|", "/").replaceAll("\n", " ");
  const link = (shot) => (shot ? `[shot](${shot})` : "");
  const rows = (list, kinds) => grouped(list).map((g) => {
    const f = g.first;
    const shot = g.keys.map((key) => shots.get(key)).find(Boolean);
    return `| ${f.record.skin} | ${kinds[f.kind]} | ${cell(f.item.by ?? f.item.text ?? "")} | \`${f.item.key}\` | ${cell([...g.pages].join(", "))} | ${[...g.widths].join(", ")} | ${link(shot)} |`;
  }).join("\n");
  const head = "| Skin | Finding | Measure | Marker | Pages and states | Widths | Screenshot |\n|---|---|---|---|---|---|---|";
  writeFileSync(join(reportDir, "report.md"), [
    "# UI audit report", "", summary, "",
    `## Blocking (${blocking.length} findings, ${grouped(blocking).length} groups)`, "", blocking.length ? `${head}\n${rows(blocking, KINDS)}` : "None.", "",
    `## Advisory (${advisory.length} findings, ${grouped(advisory).length} groups)`, "", "A reviewer judges these; they do not fail the gate.", "", advisory.length ? `${head}\n${rows(advisory, ADVISORY)}` : "None.", "",
  ].join("\n"));
  const flat = (list) => list.map(({ record, ...f }) => ({ ...f, skin: record.skin, name: record.name, width: record.width, theme: record.theme, menu: record.menu }));
  writeFileSync(join(reportDir, "report.json"), JSON.stringify({ blocking: flat(blocking), advisory: flat(advisory) }, null, 1));
}

// ---- Self-test ---------------------------------------------------------------

// The probe records of one fixture at one width; a menu fixture adds one record per menu.
async function fixtureRecords(tab, fixture, width) {
  await setWidth(tab, width);
  await tab.goto(pathToFileURL(join(here, "fixtures", fixture.file)).href);
  await settle(tab);
  if (fixture.state) {
    const state = { skin: "fixture", route: null, width, theme: "light", state: fixture.state, name: fixture.file };
    const result = await runState(tab, state).catch((error) => ({ error: String(error) }));
    return [{ width, found: result?.found ?? { error: [{ key: "state", by: result?.error ?? "absent" }] } }];
  }
  const records = [{ width, found: await probe(tab, width) }];
  if (fixture.menus) for (const menu of await walkMenus(tab, width)) records.push({ width, found: menu.found });
  return records;
}

// One fixture: the finding kinds it shows, and the verdict against what it must show.
async function runFixture(tab, fixture) {
  await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  const records = [];
  for (const width of fixture.widths) records.push(...(await fixtureRecords(tab, fixture, width))); // NOSONAR one tab, width by width
  const kinds = new Set(records.flatMap((r) => Object.entries(r.found).filter(([, items]) => items.length > 0).map(([kind]) => kind)));
  const missing = fixture.expect.filter((kind) => !kinds.has(kind));
  const unwanted = (fixture.clean ?? []).filter((kind) => kinds.has(kind));
  const ok = missing.length === 0 && unwanted.length === 0;
  const notes = [];
  if (missing.length > 0) notes.push(`missed ${missing.join(", ")}`);
  if (unwanted.length > 0) notes.push(`false ${unwanted.join(", ")}`);
  const verdict = notes.map((note) => `; ${note}`).join("");
  console.log(`${ok ? "ok  " : "FAIL"} ${fixture.miss.padEnd(4)} ${fixture.file.padEnd(28)} expects ${fixture.expect.join(", ")}${verdict}`);
  return ok;
}

// Each fixture reproduces one miss of the old gate; the probe must name it.
async function runSelfTest(browser) {
  const { FIXTURES } = await import("./fixtures/fixtures.mjs");
  const tab = await browser.open();
  let failed = 0;
  for (const fixture of FIXTURES) {
    if (!(await runFixture(tab, fixture))) failed += 1; // NOSONAR one tab, fixture by fixture
  }
  console.log(failed === 0 ? `self-test: ${FIXTURES.length} fixtures, every miss caught` : `self-test: ${failed} of ${FIXTURES.length} fixtures failed`);
  return failed === 0 ? 0 : 1;
}

// ---- Main --------------------------------------------------------------------

const started = Date.now();

// A state whose control is gone at every width, or at the desktop width,
// has left the gate: that is a finding, not a skip.
function addLostStates(records) {
  const tried = new Map();
  for (const r of records.filter((r) => r.name.startsWith("state:"))) {
    const id = `${r.skin}|${r.name}`;
    if (!tried.has(id)) tried.set(id, []);
    tried.get(id).push(r);
  }
  for (const list of tried.values()) {
    const desktop = list.filter((r) => r.width === 1440);
    const phoneOnly = STATES.find((state) => `state:${state.name}` === list[0].name)?.phoneOnly?.includes(list[0].skin);
    const everywhere = list.every((r) => r.absent);
    const lost = everywhere || (!phoneOnly && desktop.length > 0 && desktop.every((r) => r.absent));
    if (lost) records.push({ ...list[0], width: everywhere ? "*" : 1440, theme: "*", absent: false, found: { error: [{ key: "state", sel: list[0].name, by: "no control opens this state" }] } });
  }
}

// Each worker tab takes the next job until none is left.
async function runJobs(tabs, jobs) {
  const records = [];
  let next = 0;
  await Promise.all(tabs.map(async (tab) => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      await runJob(tab, job, records); // NOSONAR one tab runs its jobs in turn
    }
  }));
  return records;
}

function summaryOf(probes, jobs, workers, blocking, fresh, advisory) {
  const advisoryNote = advise ? `, ${advisory.length} advisory` : "";
  const seconds = Math.round((Date.now() - started) / 1000);
  return `${probes} probes (${jobs.length} jobs, ${workers} tabs) in ${seconds}s: ${SKINS.join(" and ")}; ${blocking.length} blocking findings, ${blocking.length - fresh.length} accepted${advisoryNote}.`;
}

function printVerdict(fresh) {
  if (accept) {
    const lines = fresh.map((f) => `${f.key}  # `).join("\n");
    console.log(`\nlines for accepted.txt (add a reason after " # " to each):\n${lines}`);
  } else if (fresh.length > 0) {
    console.log(`\nbreakpoint gate: ${fresh.length} new findings`);
    for (const f of fresh) console.log(line(f, KINDS));
    const keys = fresh.map((f) => `  ${f.key}`).join("\n");
    console.log(`\nkeys:\n${keys}`);
  } else {
    console.log("\nbreakpoint gate: no new findings");
  }
}

async function runAudit(browser) {
  // A fresh report each run: no picture from an older one stays behind.
  if (advise) rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(reportDir, { recursive: true });
  const jobs = plan();
  const workers = Math.max(1, Number(process.env.AUDIT_WORKERS ?? Math.min(4, availableParallelism())));
  const tabs = await Promise.all(Array.from({ length: workers }, () => browser.open()));
  const records = await runJobs(tabs, jobs);
  addLostStates(records);
  const probes = records.filter((r) => !r.absent && !r.found?.error).length;
  if (process.env.AUDIT_JSON) writeFileSync(process.env.AUDIT_JSON, JSON.stringify(records, null, 1));
  const blocking = findings(records, KINDS);
  const advisory = advise ? findings(records, ADVISORY) : [];
  const { rules, problems } = readAccepted();
  const fresh = blocking.filter((f) => {
    const rule = acceptedBy(rules, f);
    if (!rule) return true;
    rule.used = true;
    return false;
  });
  const summary = summaryOf(probes, jobs, workers, blocking, fresh, advisory);
  console.log(summary);
  if (advise) {
    // A picture per page for what blocks, and one per advisory group.
    const firsts = grouped(advisory).map((g) => g.first).filter((f) => f.item.box);
    const shots = await shoot(tabs, [...fresh, ...firsts], "shot");
    writeReport(fresh, advisory, shots, summary);
    console.log(`report: ${join(reportDir, "report.md")} (${grouped(advisory).length} advisory groups)`);
  }
  // A run that measured almost nothing has not checked the console. Menu and
  // state records are extra, so they cannot hide a page that was not reached.
  const expected = jobs.filter((job) => job.type !== "state").reduce((sum, job) => sum + (job.widths?.length ?? 1), 0);
  const pageProbes = records.filter((r) => !r.menu && !r.name.startsWith("state:") && !r.absent && !r.found?.error).length;
  if (pageProbes < expected) problems.push(`only ${pageProbes} page probes for ${expected} expected: the run did not reach the pages`);
  for (const problem of problems) console.log(problem);
  const unused = rules.filter((rule) => !rule.used);
  // A narrowed run does not see every finding, so it cannot call a line stale.
  const narrowed = onlyRoutes || onlyWidths || onlyStates || process.env.SKIN || process.env.AUDIT_STRIDE === "0";
  if (unused.length > 0 && !narrowed) {
    const stale = unused.map((rule) => `  ${rule.line}`).join("\n");
    console.log(`\n${unused.length} accepted lines no longer match; remove them from accepted.txt:\n${stale}`);
  }
  printVerdict(fresh);
  if (gate) process.exitCode = fresh.length > 0 || problems.length > 0 ? 1 : 0;
}

const browser = await launch();
try {
  if (selfTest) process.exitCode = await runSelfTest(browser);
  else await runAudit(browser);
} finally {
  browser.close();
}
