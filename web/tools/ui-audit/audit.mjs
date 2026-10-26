// Runtime UI audit: every route at every breakpoint, probed in the page.
// node audit.mjs <baseUrl> <out.json> [light|dark]
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// usage: audit.mjs [--gate [--accept]] [base-url] [detail-file|-] [light|dark]
// The detail file is opt-in: pass a path to keep the raw findings, otherwise the
// run prints its report and leaves nothing behind.
//
// --gate is the breakpoint guard CI runs: both skins at both sides of every
// step, failing on any layout finding accepted.txt does not list. --accept
// rewrites accepted.txt with what this run found, for a reviewed exception.
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const gate = flags.has("--gate");
const accept = flags.has("--accept");
const [base = "http://localhost:5173", detail = "-", scheme = "light"] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const out = detail === "-" ? null : detail;
// SKIN=terminal audits another face; the console is worn when it is unset. The
// gate wears both unless SKIN names one.
const skins = process.env.SKIN ? [process.env.SKIN] : gate ? ["console", "terminal"] : [""];
const accepted = join(dirname(fileURLToPath(import.meta.url)), "accepted.txt");

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
  ["console", "/?demo&latency=0#/console/minecraft"],
  ["metrics", "/?demo&latency=0#/metrics/minecraft"],
  ["access-users", "/?demo&latency=0#/access/users"],
  ["access-roles", "/?demo&latency=0#/access/roles"],
  ["access-notifications", "/?demo&latency=0#/access/notifications"],
  ["profile", "/?demo&latency=0#/profile"],
];

// Both sides of every breakpoint, because a rule that fires one pixel early is
// invisible to a list of round numbers. The scale itself is in web/DESIGN.md.
const VIEWPORTS = [
  [360, 780, true],
  [390, 844, true],
  [599, 900, true],
  [600, 900, true],
  [768, 1024, true],
  [839, 1024, true],
  [840, 1024, true],
  [959, 900, true],
  [960, 900, false],
  [1199, 900, false],
  [1200, 900, false],
  [1440, 900, false],
  [1920, 1080, false],
  // A 4K monitor at the usual 150–200% scaling is 1920–2560 CSS px; 3840 is
  // what 100% scaling gives, kept as the smoke test for the open-ended pane.
  [2560, 1440, false],
  [3840, 2160, false],
];

// The gate: both sides of every step, and a phone and a desktop. A step is
// where a rule changes, so that is where a layout breaks.
const GATE_WIDTHS = new Set([360, 599, 600, 839, 840, 959, 960, 1440]);
// While fixing, AUDIT_ROUTES=world,world-backups and AUDIT_WIDTHS=360,600 narrow a run.
const onlyRoutes = process.env.AUDIT_ROUTES ? new Set(process.env.AUDIT_ROUTES.split(",")) : null;
const onlyWidths = process.env.AUDIT_WIDTHS ? new Set(process.env.AUDIT_WIDTHS.split(",").map(Number)) : null;

// Layout promises the panel makes, each owned by the primitive named. The
// probe holds every page to them; a new primitive that makes one adds it here.
const LAYOUT = {
  // PageHeader and the terminal page head: who this is and what can be done
  // about it share one line from the phone step up.
  oneLine: [[".page-title-row", 600], [".t-page-head", 600]],
  // Details rows: a label beside its value shares the baseline of the value's first line.
  pairs: [".details-row", ".t-detail"],
  // Cards and panels: what starts a line inside one starts on one edge — the
  // title, a search field, a table's first column, the detail labels. A
  // nested card keeps its own edge.
  rails: {
    containers: ".card, .t-panel",
    // An empty table's one cell is its state, centred across the table, not a column.
    starts: [".card-header h2", ".filter-bar .search", ".table th:first-child", ".table td:first-child:not(.table-empty)", ".details-row > dt",
      ".t-filter-row .t-field", ".t-table th:first-child", ".t-table tr:not(.t-table-state) > td:first-child", ".t-detail > dt"],
  },
  // EmptyState and the terminal Empty sit in the middle of their box.
  centred: [".empty", ".t-empty"],
  // Menu and Overflow: where each item's label begins.
  menuLabels: ".menu-item > span, .t-menu-copy",
};


const KINDS = [
  ["sideways", "scrolls sideways"],
  ["overflowing", "past the viewport"],
  ["clipped", "cut with no ellipsis"],
  ["smallTargets", "target below the floor"],
  ["contrast", "contrast below 4.5"],
  ["overlaps", "text under a control"],
  ["textOverText", "text over text"],
  ["wrapped", "row broke its line"],
  ["offCentre", "empty state off centre"],
  ["misaligned", "label off its value"],
  ["offRail", "start off the card edge"],
  ["menuClipped", "menu label cut"],
  ["menuRagged", "menu labels ragged"],
];

// What the gate fails on: geometry that is either right or broken. Targets
// and contrast stay in the report, where a disabled control is judged by eye.
const GATED = new Set(["sideways", "overflowing", "overlaps", "textOverText", "wrapped", "offCentre", "misaligned", "offRail", "menuClipped", "menuRagged"]);

function report(findings) {
  const totals = new Map(KINDS.map(([key]) => [key, 0]));
  const lines = [];
  for (const probe of findings) {
    for (const [key, label] of KINDS) {
      for (const item of probe[key] ?? []) {
        totals.set(key, totals.get(key) + 1);
        const what = item.sel ?? item.selector ?? item.text ?? "";
        const detail = typeof item.by === "string" ? item.by
          : item.by !== undefined ? `${item.by > 0 ? "+" : ""}${item.by}px`
          : item.w !== undefined ? `${item.w}x${item.h}`
          : item.ratio !== undefined ? `${item.ratio.toFixed(2)}:1`
          : "";
        lines.push(`  ${(probe.skin || "console").padEnd(8)} ${probe.route.padEnd(18)} ${String(probe.width).padStart(5)}px  ${label.padEnd(24)} ${detail.padEnd(10)} ${String(what).slice(-64)}`);
      }
    }
  }
  const counted = KINDS.map(([key, label]) => `${label}: ${totals.get(key)}`).join(", ");
  console.log(`${findings.length} probes across ${new Set(findings.map((f) => f.width)).size} widths`);
  console.log(counted);
  if (lines.length > 0) {
    console.log("");
    // Contrast on disabled controls is exempt from WCAG and would drown the rest.
    for (const line of lines.filter((line) => !line.includes("contrast below"))) console.log(line);
  }
}

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
    overflowing: [], clipped: [], sideways: [], smallTargets: [], fonts: {}, radii: {}, zIndex: {},
    contrast: [], shadows: [], fontFamilies: {},
  };

  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (!visible(el, rect)) continue;
    const cs = getComputedStyle(el);
    // Text parked off-screen for a reader is meant to be clipped and meant to
    // be outside the viewport. Counting it drowned the real findings: 185 of
    // 185 clipped entries were this, and nobody reads a report that cries wolf.
    // Detected by the technique rather than by a class name, because the same
    // properties are applied inline by a media query in at least one place.
    if (cs.clipPath === "inset(50%)" || el.closest(".visually-hidden") !== null) continue;

    // 1. Horizontal overflow past the viewport, with no scroll container to excuse it.
    // Chrome that lives off-canvas until it is opened — a closed navigation
    // drawer, a sheet at rest — is parked, not overflowing. Only what sticks out
    // past the right edge can force the page sideways.
    if (rect.right > window.innerWidth + 1 && rect.left >= -1 && !scrollableAncestor(el)) {
      result.overflowing.push({ sel: path(el), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) });
    }

    // 2. Content cut off with no ellipsis to announce it.
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX === "hidden" && cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.textContent.trim()) {
      result.clipped.push({ sel: path(el), scroll: el.scrollWidth, client: el.clientWidth, text: el.textContent.trim().slice(0, 40) });
    }

    // 3. A container that scrolls sideways. The overflow probe above excuses
    // anything inside a scroll box, which is exactly where a table that no
    // longer fits its card goes to hide: it does not stick out, it scrolls, and
    // the reader finds half a row and no clue there is more.
    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1
        && el.dataset.scroll !== "expected") {
      result.sideways.push({ sel: path(el), scroll: el.scrollWidth, client: el.clientWidth, by: el.scrollWidth - el.clientWidth });
    }

    // 4. Targets, measured against the pointer that is actually pointing. A
    // finger wants the 32px this project's own touch rules aim at; a mouse is
    // held to WCAG 2.5.8's 24px, and holding it to 32 flags controls that no
    // standard objects to.
    const floor = __COARSE__ ? 32 : 24;
    const interactive = el.matches("button, a[href], input, select, textarea, [role=menuitem], [role=tab], summary");
    if (interactive && (rect.width < floor || rect.height < floor) && cs.display !== "contents") {
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

      // 5. Contrast of real text against its effective background. An inactive
      // control is out of scope for the contrast rule itself, and counting one
      // buries the findings that are real: every disabled button in the panel
      // was reported, sixty-six of them, and none was a fault.
      const inactive = el.closest("[disabled], [aria-disabled=true]") !== null;
      const fg = inactive ? null : toRgb(cs.color);
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

  const layout = __LAYOUT__;
  // What of a box can be seen: inside the viewport's width and every box above
  // it that clips. A tab scrolled out of its strip, a closed drawer parked off
  // the edge and the hidden end of a truncated name are not on the page.
  const clipBoxes = new Map();
  const clipBox = (el) => {
    if (clipBoxes.has(el)) return clipBoxes.get(el);
    const parent = el.parentElement;
    let box = parent && parent !== document.documentElement ? clipBox(parent) : { left: 0, right: window.innerWidth, top: -Infinity, bottom: Infinity };
    if (parent) {
      const pcs = getComputedStyle(parent);
      if (pcs.overflowX !== "visible" || pcs.overflowY !== "visible") {
        const r = parent.getBoundingClientRect();
        box = { left: Math.max(box.left, r.left), right: Math.min(box.right, r.right), top: Math.max(box.top, r.top), bottom: Math.min(box.bottom, r.bottom) };
      }
    }
    clipBoxes.set(el, box);
    return box;
  };
  // within: also the element's own box when it clips, as a text run is clipped
  // by the element that holds it (an ellipsis keeps its whole text inside).
  const seen = (r, el, within = false) => {
    let box = clipBox(el);
    const ecs = within ? getComputedStyle(el) : null;
    if (ecs && (ecs.overflowX !== "visible" || ecs.overflowY !== "visible")) {
      const own = el.getBoundingClientRect();
      box = { left: Math.max(box.left, own.left), right: Math.min(box.right, own.right), top: Math.max(box.top, own.top), bottom: Math.min(box.bottom, own.bottom) };
    }
    const s = { left: Math.max(r.left, box.left), right: Math.min(r.right, box.right), top: Math.max(r.top, box.top), bottom: Math.min(r.bottom, box.bottom) };
    return s.right - s.left > 0 && s.bottom - s.top > 0 ? s : null;
  };
  const textRuns = (root) => {
    const runs = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement;
      // A glyph hidden from readers is decoration laid over its control on purpose, as a select's caret is.
      if (!node.textContent.trim() || !owner || owner.closest(".visually-hidden, script, style, [aria-hidden=true]")) continue;
      const ocs = getComputedStyle(owner);
      if (ocs.visibility === "hidden" || ocs.display === "none" || ocs.clipPath === "inset(50%)") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const r = rect.width >= 1 && rect.height >= 1 ? seen(rect, owner, true) : null;
        if (r) runs.push({ node, r, raw: rect, text: node.textContent.trim().slice(0, 30) });
      }
    }
    return runs;
  };
  const cross = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
  result.overlaps = []; result.textOverText = []; result.wrapped = []; result.offCentre = []; result.misaligned = []; result.offRail = [];

  // 8. Text under a control, or one control over another: the corner key a
  // short name ran under. A control's own text, and a control inside another
  // (a button in a label), are not collisions.
  const controls = all
    .filter((el) => el.matches("button, a[href], input, select, textarea") && visible(el, el.getBoundingClientRect()) && el.closest(".visually-hidden") === null)
    .map((el) => ({ el, r: seen(el.getBoundingClientRect(), el) }))
    .filter((control) => control.r !== null);
  const runs = textRuns(document.body);
  for (const control of controls) {
    const hit = runs.find((run) => !control.el.contains(run.node) && cross(control.r, run.r))
      ?? controls.find((other) => other !== control && !other.el.contains(control.el) && !control.el.contains(other.el) && cross(control.r, other.r));
    if (hit) result.overlaps.push({ sel: path(control.el), text: hit.text ?? path(hit.el) });
  }

  // 8b. Text over text: two text nodes that share pixels, as a badge laid over
  // a title or a long value run into its neighbour. A run's box is the font's
  // whole ascent and descent, taller than its glyphs, and two lines of tight
  // leading share that margin by design; so each box is trimmed to the middle
  // of its line before the pair is compared.
  const cores = runs
    .map((run) => { const inset = (run.r.bottom - run.r.top) * 0.2; return { ...run, c: { left: run.r.left, right: run.r.right, top: run.r.top + inset, bottom: run.r.bottom - inset } }; })
    .sort((a, b) => a.c.top - b.c.top);
  const reported = new Set();
  for (let i = 0; i < cores.length; i++) {
    for (let j = i + 1; j < cores.length && cores[j].c.top < cores[i].c.bottom; j++) {
      const [a, b] = [cores[i], cores[j]];
      if (a.node === b.node || !cross(a.c, b.c)) continue;
      const sel = path(b.node.parentElement);
      if (reported.has(sel)) continue;
      reported.add(sel);
      result.textOverText.push({ sel, by: "“" + b.text.slice(0, 12) + "” on “" + a.text.slice(0, 12) + "”" });
    }
  }

  // 9. A row that promised one line and broke it.
  for (const [selector, from] of layout.oneLine) {
    if (window.innerWidth < from) continue;
    for (const row of document.querySelectorAll(selector)) {
      const kids = Array.from(row.children).filter((kid) => visible(kid, kid.getBoundingClientRect()));
      if (kids.length < 2) continue;
      const first = kids[0].getBoundingClientRect();
      const broken = kids.slice(1).find((kid) => { const r = kid.getBoundingClientRect(); return r.top >= first.bottom - 1 || r.bottom <= first.top + 1; });
      if (broken) result.wrapped.push({ sel: path(broken) });
    }
  }

  // 10. An empty state that is not in the middle of its box.
  for (const selector of layout.centred) {
    for (const el of document.querySelectorAll(selector)) {
      const r = el.getBoundingClientRect();
      if (!visible(el, r) || !el.parentElement) continue;
      const p = el.parentElement.getBoundingClientRect();
      const pcs = getComputedStyle(el.parentElement);
      const middle = (p.left + parseFloat(pcs.borderLeftWidth) + parseFloat(pcs.paddingLeft) + p.right - parseFloat(pcs.borderRightWidth) - parseFloat(pcs.paddingRight)) / 2;
      const by = Math.round((r.left + r.right) / 2 - middle);
      if (Math.abs(by) > 4) result.offCentre.push({ sel: path(el), by });
    }
  }

  // 11. A label beside its value that does not share the baseline of the
  // value's first line. Text of two sizes centred on one line still sits a pixel
  // or two apart, and the eye reads the baselines. A label above its value, as
  // a narrow record stacks them, has no line to share.
  const metrics = document.createElement("canvas").getContext("2d");
  const baseline = (el) => {
    const run = textRuns(el)[0];
    if (!run) return null;
    const cs = getComputedStyle(run.node.parentElement);
    metrics.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    return run.raw.bottom - metrics.measureText(run.node.textContent).fontBoundingBoxDescent;
  };
  for (const selector of layout.pairs) {
    for (const row of document.querySelectorAll(selector)) {
      const [label, value] = row.children;
      if (!label || !value || !visible(row, row.getBoundingClientRect())) continue;
      if (value.getBoundingClientRect().left < label.getBoundingClientRect().right - 1) continue;
      const l = baseline(label), v = baseline(value);
      if (l === null || v === null) continue;
      const by = Math.round((v - l) * 10) / 10;
      if (Math.abs(by) > 1) result.misaligned.push({ sel: path(row), by, text: label.textContent.trim().slice(0, 24) });
    }
  }

  // 12. What starts a line inside a card or panel and does not start on its
  // edge: where its content begins, inside its own padding (a field, by its box).
  const start = (el) => {
    const r = el.getBoundingClientRect();
    if (el.matches(".search, .t-field")) return r.left;
    const cs = getComputedStyle(el);
    return r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  };
  for (const container of document.querySelectorAll(layout.rails.containers)) {
    if (!visible(container, container.getBoundingClientRect())) continue;
    const edges = [];
    for (const selector of layout.rails.starts) {
      const el = Array.from(container.querySelectorAll(selector)).find((candidate) => candidate.closest(layout.rails.containers) === container && visible(candidate, candidate.getBoundingClientRect()));
      if (el) edges.push({ what: selector, x: Math.round(start(el)) });
    }
    if (edges.length < 2) continue;
    const edge = edges[0].x;
    const off = edges.filter((item) => Math.abs(item.x - edge) > 1);
    if (off.length > 0) result.offRail.push({ sel: path(container), by: off.map((item) => item.what + " " + (item.x - edge > 0 ? "+" : "") + (item.x - edge) + "px").join(", "), edge: edges[0].what });
  }
  return JSON.stringify(result);
})()`;

// Menus are measured open: the first row menu of the page, where the clipped
// Archive label was. Its labels must stay inside it and begin on one edge.
const MENU_PROBE = String.raw`(async () => {
  const layout = __LAYOUT__;
  const trigger = Array.from(document.querySelectorAll("[aria-haspopup=menu][aria-controls]"))
    .find((el) => el.closest("table") && el.getBoundingClientRect().width > 0);
  if (!trigger) return JSON.stringify({});
  trigger.click();
  await new Promise((r) => setTimeout(r, 300));
  const menu = document.getElementById(trigger.getAttribute("aria-controls"));
  const result = { menuClipped: [], menuRagged: [] };
  if (!menu) return JSON.stringify(result);
  const m = menu.getBoundingClientRect();
  const starts = [];
  for (const label of menu.querySelectorAll(layout.menuLabels)) {
    const range = document.createRange();
    range.selectNodeContents(label);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width >= 1);
    if (rects.length === 0) continue;
    starts.push(Math.min(...rects.map((r) => r.left)));
    if (rects.some((r) => r.right > m.right + 1 || r.left < m.left - 1)) result.menuClipped.push({ sel: trigger.getAttribute("aria-label"), text: label.textContent.trim().slice(0, 30) });
  }
  if (starts.length > 1 && Math.max(...starts) - Math.min(...starts) > 2) result.menuRagged.push({ sel: trigger.getAttribute("aria-label"), by: Math.round(Math.max(...starts) - Math.min(...starts)) });
  if (typeof menu.hidePopover === "function" && menu.matches(":popover-open")) menu.hidePopover();
  return JSON.stringify(result);
})()`;

// One line per gated finding, stable across runs: what accepted.txt lists.
function findingKeys(findings) {
  const keys = new Set();
  for (const probe of findings) {
    if (probe.error) keys.add(`${probe.skin || "console"} ${probe.route} ${probe.width} error ${probe.error.slice(0, 80)}`);
    for (const kind of GATED) {
      for (const item of probe[kind] ?? []) keys.add(`${probe.skin || "console"} ${probe.route} ${probe.width} ${kind} ${item.sel ?? ""}`);
    }
  }
  return [...keys].sort();
}

// Fails on a finding the reviewed list does not hold; a listed finding that is
// gone is reported so the list shrinks as the panel is fixed.
function judge(findings) {
  const found = findingKeys(findings);
  if (accept) {
    writeFileSync(accepted, ["# Layout findings the breakpoint gate accepts, one per line: skin route width kind selector.",
      "# Written by `npm run audit:ui:gate -- --accept`; every line here is a reviewed exception, not a backlog.", ...found, ""].join("\n"));
    console.log(`\naccepted ${found.length} findings into ${accepted}`);
    return 0;
  }
  const known = new Set(existsSync(accepted) ? readFileSync(accepted, "utf8").split("\n").filter((line) => line && !line.startsWith("#")) : []);
  const fresh = found.filter((key) => !known.has(key));
  const gone = [...known].filter((key) => !found.includes(key));
  if (gone.length > 0) console.log(`\n${gone.length} accepted findings no longer occur; remove them from accepted.txt:\n${gone.map((key) => `  ${key}`).join("\n")}`);
  if (fresh.length === 0) {
    console.log(`\nbreakpoint gate: no new layout findings (${found.length} accepted)`);
    return 0;
  }
  console.log(`\nbreakpoint gate: ${fresh.length} new layout findings\n${fresh.map((key) => `  ${key}`).join("\n")}`);
  return 1;
}

const chrome = process.env.CHROME_BIN ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "/usr/bin/chromium");
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

  const layout = JSON.stringify(LAYOUT);
  for (const skin of skins) {
    const skinQuery = skin ? `&skin=${encodeURIComponent(skin)}` : "";
    for (const [width, height, mobile] of VIEWPORTS.filter(([width]) => (!gate || GATE_WIDTHS.has(width)) && (!onlyWidths || onlyWidths.has(width)))) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
      for (const [name, route] of ROUTES.filter(([name]) => !onlyRoutes || onlyRoutes.has(name))) {
        // A hash-only change reuses the document and never fires a load event, so
        // every probe gets a unique query parameter and a timeout to fall back on.
        pass += 1;
        const joiner = route.includes("?") ? "&" : "?";
        const [path, hash = ""] = route.split("#");
        const url = `${base}${path}${joiner}probe=${pass}${skinQuery}${hash ? "#" + hash : ""}`;
        const loaded = new Promise((r) => { onLoad = r; });
        await send("Page.navigate", { url });
        await Promise.race([loaded, sleep(8000)]);
        await sleep(gate ? 400 : 600);
        // The runner knows which pointer it is emulating; the page does not have
        // to be asked, and in headless it answers unreliably.
        const probe = await send("Runtime.evaluate", { expression: PROBE.replace("__COARSE__", String(mobile)).replace("__LAYOUT__", layout), returnByValue: true, awaitPromise: false });
        const raw = probe.result?.result?.value;
        if (!raw) { findings.push({ skin, route: name, width, error: JSON.stringify(probe.result).slice(0, 300) }); continue; }
        const menus = await send("Runtime.evaluate", { expression: MENU_PROBE.replace("__LAYOUT__", layout), returnByValue: true, awaitPromise: true });
        findings.push({ skin, route: name, width, mobile, ...JSON.parse(raw), ...JSON.parse(menus.result?.result?.value ?? "{}") });
      }
    }
  }
  report(findings);
  if (gate) process.exitCode = judge(findings);
  // The detail is written only when it is asked for, and never into the working
  // tree by default: 169 probes of every font, radius and z-index on the page is
  // 28k lines of JSON that nobody reads and git would have been asked to keep.
  if (out !== null) {
    writeFileSync(out, JSON.stringify(findings, null, 1));
    console.log(`\ndetail: ${out}`);
  }
} finally {
  ws.close();
  proc.kill();
}
