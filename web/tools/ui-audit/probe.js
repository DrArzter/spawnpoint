// The in-page probe. audit.mjs evaluates this whole file in the page, calls
// `probe(options)` and reads back the findings. It runs in the browser: no
// imports, no Node. One function per check; `ctx` holds the shared state.
//
// options: { width, coarse, layout, advise, root }
// - width: the width the runner set; the layout viewport must not grow past it.
// - layout: selectors for skins without markers (LAYOUT in audit.mjs).
// - root: a dialog, panel or menu is open; only its layer is measured.

const CONTROL = "button, a[href], input, select, textarea, [role=button], [role=menuitem], [role=tab], summary";
const ITEMS = "[data-layout~=rows] tr, [data-layout~=rows] [role=row], [role=listitem], li, [role=option], [role=radio], [role=menuitem], button, a[href]";
const SCOPES = `${ITEMS}, [data-scope], dialog, [role=menu]`;
const MENU_ITEMS = "[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]";
const NO_COPY = "[data-copy=recovery], [role=alert], [role=log], [role=tooltip], table, [role=table], pre, code";

// eslint-disable-next-line no-unused-vars
function probe(options) {
  const ctx = makeContext(options);
  collectRuns(ctx);
  collectAtoms(ctx);
  checkOverlaps(ctx);
  checkPageWidth(ctx);
  checkEdges(ctx);
  checkOneLine(ctx);
  checkCentred(ctx);
  checkPairs(ctx);
  checkRails(ctx);
  checkSpread(ctx);
  checkStateTwice(ctx);
  checkRows(ctx);
  checkIconLines(ctx);
  checkCrumbs(ctx);
  checkGrids(ctx);
  checkMenu(ctx);
  if (ctx.advise) {
    checkContrast(ctx);
    checkLoosePacked(ctx);
    checkCopy(ctx);
  }
  return ctx.out;
}

function makeContext(options) {
  const { width, coarse, layout, advise } = options;
  return {
    width, coarse, layout, advise,
    // A menu is measured on its own: only what is inside it.
    root: options.root ? document.querySelector(options.root) : null,
    all: Array.from(document.querySelectorAll("body *")),
    metrics: document.createElement("canvas").getContext("2d"),
    modal: findModal(),
    styles: new Map(),
    layers: new Map(),
    clipBoxes: new Map(),
    inkCache: new Map(),
    runs: [],
    atoms: [],
    out: {
      wider: [], overflowing: [], sideways: [], overlaps: [], textOverText: [], wrapped: [], offCentre: [], misaligned: [], offRail: [],
      menuClipped: [], menuRagged: [], menuCut: [],
      packed: [], columns: [], repeatedLabel: [], iconOffLine: [], crumbRepeat: [], gridEdge: [], cardHeights: [], stateTwice: [],
      // Advisory only.
      clipped: [], smallTargets: [], contrast: [], loosePacked: [], copy: [], stretched: [],
    },
  };
}

// ---- Element helpers -----------------------------------------------------

function style(ctx, el) {
  let cs = ctx.styles.get(el);
  if (!cs) {
    cs = getComputedStyle(el);
    ctx.styles.set(el, cs);
  }
  return cs;
}

function hiddenByTechnique(ctx, el) {
  return style(ctx, el).clipPath === "inset(50%)" || el.closest(".visually-hidden, .c-sr, .sr-only") !== null;
}

// An ancestor at zero opacity hides its subtree.
function ancestorFaded(ctx, el) {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    if (Number(style(ctx, node).opacity) === 0) return true;
  }
  return false;
}

function visible(ctx, el, rect = el.getBoundingClientRect()) {
  const cs = style(ctx, el);
  if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
  if (rect.width < 1 || rect.height < 1) return false;
  if (el.closest("[hidden], [inert]")) return false;
  return !ancestorFaded(ctx, el);
}

// A box the checks may measure: shown, not hidden by a technique, in scope.
function measurable(ctx, el, rect = el.getBoundingClientRect()) {
  return visible(ctx, el, rect) && !hiddenByTechnique(ctx, el) && inScope(ctx, el);
}

function visibleChildren(ctx, el) {
  return Array.from(el.children).filter((kid) => visible(ctx, kid));
}

function dataMarker(d) {
  if (d.action) return `[data-action=${d.action}]`;
  if (d.col) return `[data-col=${d.col}]`;
  if (d.layout) return `[data-layout=${d.layout}]`;
  if (d.layer) return `[data-layer=${d.layer}]`;
  return d.status ? "[data-status]" : null;
}

function roleMarker(node) {
  const role = node.getAttribute("role");
  return role && role !== "presentation" ? `[role=${role}]` : null;
}

function markBit(node, depth) {
  const d = node.dataset ?? {};
  let bit = dataMarker(d) ?? roleMarker(node);
  if (bit === null && depth === 0) bit = node.tagName.toLowerCase();
  if (bit && depth === 0 && node.getAttribute("aria-label") && !d.action) bit += "[aria-label]";
  return bit;
}

// A stable name for an element: markers and roles, never a class path.
function mark(el) {
  const bits = [];
  for (let node = el, depth = 0; node && node !== document.body && depth < 6 && bits.length < 3; node = node.parentElement, depth += 1) {
    const bit = markBit(node, depth);
    if (bit) bits.unshift(bit);
  }
  return bits.join(" ");
}

// The class path, for a person reading the report; keys use `mark`.
function path(el) {
  const bits = [];
  for (let node = el, i = 0; node && i < 4; i += 1, node = node.parentElement) {
    const cls = typeof node.className === "string" && node.className ? "." + node.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    bits.unshift(node.tagName.toLowerCase() + cls);
  }
  return bits.join(" > ");
}

function box(r) {
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.right - r.left), h: Math.round(r.bottom - r.top) };
}

function finding(ctx, kind, el, extra = {}) {
  const r = el?.getBoundingClientRect?.();
  ctx.out[kind].push({ key: el ? mark(el) : "page", sel: el ? path(el) : "page", ...(r ? { box: box(r) } : {}), ...extra });
}

function scrollableAncestor(ctx, el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const cs = style(ctx, node);
    if (cs.overflowX === "auto" || cs.overflowX === "scroll") return true;
  }
  return false;
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

// ---- Layers ----------------------------------------------------------------
// A layer is what paints over the page as one surface: an open modal dialog,
// an open popover, a fixed or sticky bar, or a box marked data-layer. Boxes
// are compared only within one layer; the page under a sheet or a bar is not
// a collision.

function ownsLayer(ctx, el) {
  const cs = style(ctx, el);
  return el.matches("dialog[open]") || el.matches(":popover-open") || cs.position === "fixed" || cs.position === "sticky"
    || Boolean(el.dataset.layer && el.dataset.layer !== "glyph");
}

function layerOf(ctx, el) {
  if (ctx.layers.has(el)) return ctx.layers.get(el);
  let layer = document.body;
  if (el && el !== document.body && el !== document.documentElement) {
    layer = ownsLayer(ctx, el) ? el : layerOf(ctx, el.parentElement);
  }
  ctx.layers.set(el, layer);
  return layer;
}

function findModal() {
  const isModal = (d) => {
    try { return d.matches(":modal"); } catch { return false; }
  };
  return Array.from(document.querySelectorAll("dialog[open]")).find(isModal) ?? null;
}

// With a modal open the page is inert: only the dialog and what opens over it count.
function inScope(ctx, el) {
  const { root, modal } = ctx;
  if (root) return root.contains(el);
  if (!modal || modal.contains(el)) return true;
  const layer = layerOf(ctx, el);
  return layer !== document.body && !layer.contains(modal) && style(ctx, layer).position === "fixed" && layer.matches("[popover], [data-layer]");
}

// What of a box can be seen: inside the set width and every clipping box above it.
function clipsContent(ctx, el) {
  const cs = style(ctx, el);
  return cs.overflowX !== "visible" || cs.overflowY !== "visible";
}

function intersect(a, b) {
  return { left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) };
}

function openBox(ctx) {
  return { left: 0, right: ctx.width, top: -Infinity, bottom: Infinity };
}

function clipBox(ctx, el) {
  if (ctx.clipBoxes.has(el)) return ctx.clipBoxes.get(el);
  const parent = el.parentElement;
  let b = parent && parent !== document.documentElement ? clipBox(ctx, parent) : openBox(ctx);
  if (parent && layerOf(ctx, el) === layerOf(ctx, parent)) {
    if (clipsContent(ctx, parent)) b = intersect(b, parent.getBoundingClientRect());
  } else if (parent) {
    b = openBox(ctx);
  }
  ctx.clipBoxes.set(el, b);
  return b;
}

function seen(ctx, r, el, within = false) {
  let b = clipBox(ctx, el);
  if (within && clipsContent(ctx, el)) b = intersect(b, el.getBoundingClientRect());
  const s = intersect(r, b);
  return s.right - s.left > 0.5 && s.bottom - s.top > 0.5 ? s : null;
}

// ---- Text runs, by their ink ---------------------------------------------
// A run's box is the font's whole ascent and descent. Its ink is narrower:
// from the tallest glyph to the deepest descender, measured on the run's own
// text. Two runs collide when their ink does.

function fontOf(cs) {
  return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
}

function inkOf(ctx, cs, text) {
  const font = fontOf(cs);
  const key = font + "\u0000" + text;
  if (ctx.inkCache.has(key)) return ctx.inkCache.get(key);
  ctx.metrics.font = font;
  const m = ctx.metrics.measureText(text);
  const v = { asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent, fAsc: m.fontBoundingBoxAscent, fDesc: m.fontBoundingBoxDescent };
  ctx.inkCache.set(key, v);
  return v;
}

function isMeasuredText(ctx, owner, text) {
  if (!text || !owner || owner.closest("script, style, noscript, [data-layer=glyph]")) return false;
  return measurable(ctx, owner);
}

function textRun(ctx, node, owner, ink, text, rect) {
  if (rect.width < 1 || rect.height < 1) return null;
  const r = seen(ctx, rect, owner, true);
  if (!r) return null;
  const base = rect.top + (rect.height - (ink.fAsc + ink.fDesc)) / 2 + ink.fAsc;
  const inkBox = { left: r.left, right: r.right, top: Math.max(r.top, base - ink.asc), bottom: Math.min(r.bottom, base + ink.desc) };
  if (inkBox.bottom - inkBox.top < 0.5) return null;
  return { kind: "text", node, el: owner, r: inkBox, raw: rect, text: text.slice(0, 30), layer: layerOf(ctx, owner) };
}

function collectRuns(ctx) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const owner = node.parentElement;
    const text = node.textContent.trim();
    if (!isMeasuredText(ctx, owner, text)) continue;
    const ink = inkOf(ctx, style(ctx, owner), text);
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      const run = textRun(ctx, node, owner, ink, text, rect);
      if (run) ctx.runs.push(run);
    }
  }
}

// ---- Atoms: what may not overlap -----------------------------------------
// Text runs, icons and images, and boxes that paint: a control or a leaf
// with a fill, a full outline or an image. A control that paints nothing is
// there through its text and icons; a cell's bottom rule is not a box. An
// aria-hidden mark is an atom like any other; only a glyph marked
// data-layer="glyph" is laid over its control on purpose.

function paints(cs) {
  const bg = cs.backgroundColor;
  const fill = bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg);
  const outline = ["Top", "Right", "Bottom", "Left"].every((side) => Number.parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== "none");
  return fill || outline || cs.backgroundImage !== "none";
}

function atomKind(el) {
  if (el.tagName.toLowerCase() === "svg" && !el.parentElement.closest("svg")) return "icon";
  if (el.matches("img, canvas, video")) return "image";
  if (el.matches(CONTROL)) return "control";
  return el.children.length === 0 && !(el instanceof SVGElement) ? "box" : null;
}

function atomOf(ctx, el) {
  if (el.closest("[data-layer=glyph], script, style")) return null;
  const kind = atomKind(el);
  if (!kind) return null;
  const rect = el.getBoundingClientRect();
  if (!measurable(ctx, el, rect)) return null;
  const leaf = kind === "box";
  if ((leaf || el.matches(CONTROL)) && !paints(style(ctx, el))) return null;
  if (leaf && (rect.width < 3 || rect.height < 3)) return null;
  const r = seen(ctx, rect, el);
  return r ? { kind, el, r, layer: layerOf(ctx, el) } : null;
}

function collectAtoms(ctx) {
  ctx.atoms = ctx.runs.slice();
  for (const el of ctx.all) {
    const atom = atomOf(ctx, el);
    if (atom) ctx.atoms.push(atom);
  }
}

function cross(a, b, by = 1) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > by && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > by;
}

// Hit-testing: where the two meet, whatever paints on top must be one of them
// or in their layer; a box hidden under another layer is not on the page.
function hidden(ctx, a, b) {
  const x = (Math.max(a.r.left, b.r.left) + Math.min(a.r.right, b.r.right)) / 2;
  const y = (Math.max(a.r.top, b.r.top) + Math.min(a.r.bottom, b.r.bottom)) / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
  const top = document.elementFromPoint(x, y);
  if (!top) return false;
  const layer = layerOf(ctx, top);
  return layer !== a.layer && !a.layer.contains(layer);
}

function related(a, b) {
  const ea = a.el, eb = b.el;
  return ea === eb || ea.contains(eb) || eb.contains(ea);
}

function atomName(a) {
  return a.kind === "text" ? `“${a.text.slice(0, 14)}”` : a.kind;
}

function collides(ctx, a, b) {
  if (a.layer !== b.layer || related(a, b)) return false;
  if (a.kind === "text" && b.kind === "text" && a.node === b.node) return false;
  return cross(a.r, b.r) && !hidden(ctx, a, b);
}

function reportOverlap(ctx, reported, a, b) {
  const kind = a.kind === "text" && b.kind === "text" ? "textOverText" : "overlaps";
  const key = mark(b.el) + "|" + mark(a.el);
  if (reported.has(key)) return;
  reported.add(key);
  const joined = { left: Math.min(a.r.left, b.r.left), top: Math.min(a.r.top, b.r.top), right: Math.max(a.r.right, b.r.right), bottom: Math.max(a.r.bottom, b.r.bottom) };
  ctx.out[kind].push({ key: mark(b.el), sel: path(b.el), with: path(a.el), by: `${atomName(b)} on ${atomName(a)}`, box: box(joined) });
}

function checkOverlaps(ctx) {
  const sorted = ctx.atoms.slice().sort((a, b) => a.r.top - b.r.top);
  const reported = new Set();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].r.top < a.r.bottom; j++) {
      if (collides(ctx, a, sorted[j])) reportOverlap(ctx, reported, a, sorted[j]);
    }
  }
}

// ---- The page at the width it was given ----------------------------------
// Under mobile emulation a page wider than the phone widens the layout
// viewport with it, so innerWidth is no reference. The runner's width is.

function checkPageWidth(ctx) {
  const docWidth = document.documentElement.scrollWidth;
  if (docWidth > ctx.width + 1 || window.innerWidth > ctx.width + 1) {
    ctx.out.wider.push({ key: "page", sel: "html", by: `${Math.max(docWidth, window.innerWidth) - ctx.width}px` });
  }
}

function pastRight(r, width) {
  return r.right > width + 1 && r.left < width - 1;
}

function pastLeft(r) {
  return r.left < -1 && r.right > 1;
}

// Past either edge, with no scroll box to excuse it. A drawer parked wholly
// off the edge is closed, not overflowing.
function checkOverflow(ctx, el, rect) {
  const { width } = ctx;
  const right = pastRight(rect, width);
  if (!(right || pastLeft(rect)) || scrollableAncestor(ctx, el)) return;
  const parent = el.parentElement;
  const pr = parent?.getBoundingClientRect();
  // Report the outermost box that sticks out, not each of its children.
  const parentOut = parent && pr && (pastRight(pr, width) || pastLeft(pr)) && visible(ctx, parent, pr);
  if (!parentOut) finding(ctx, "overflowing", el, { by: right ? `+${Math.round(rect.right - width)}px` : `${Math.round(rect.left)}px` });
}

function checkSideways(ctx, el, cs) {
  if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1 && el.dataset.scroll !== "expected") {
    finding(ctx, "sideways", el, { by: el.scrollWidth - el.clientWidth });
  }
}

function checkClipped(ctx, el, cs) {
  if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX === "hidden" && cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.textContent.trim()) {
    finding(ctx, "clipped", el, { text: el.textContent.trim().slice(0, 40) });
  }
}

function checkSmallTarget(ctx, el, rect, cs) {
  const floor = ctx.coarse ? 32 : 24;
  if (el.matches(CONTROL) && (rect.width < floor || rect.height < floor) && cs.display !== "contents" && !el.closest("[aria-disabled=true], [disabled]")) {
    finding(ctx, "smallTargets", el, { by: `${Math.round(rect.width)}x${Math.round(rect.height)}` });
  }
}

function checkEdges(ctx) {
  for (const el of ctx.all) {
    const rect = el.getBoundingClientRect();
    if (!measurable(ctx, el, rect)) continue;
    const cs = style(ctx, el);
    checkOverflow(ctx, el, rect);
    checkSideways(ctx, el, cs);
    if (ctx.advise) {
      checkClipped(ctx, el, cs);
      checkSmallTarget(ctx, el, rect, cs);
    }
  }
}

// ---- Layout promises -----------------------------------------------------

function marked(ctx, name, selectors = []) {
  const set = new Set(document.querySelectorAll(`[data-layout~="${name}"]`));
  for (const sel of selectors) for (const el of document.querySelectorAll(sel)) set.add(el);
  return Array.from(set).filter((el) => inScope(ctx, el) && visible(ctx, el));
}

// One line: a row that promised one line and broke it.
function oneLineRows(ctx) {
  const rows = [...document.querySelectorAll("[data-layout~=one-line]")].map((el) => [el, Number(el.dataset.from ?? 0)]);
  for (const [sel, from] of ctx.layout.oneLine) for (const el of document.querySelectorAll(sel)) rows.push([el, from]);
  return rows;
}

function checkOneLine(ctx) {
  for (const [row, from] of oneLineRows(ctx)) {
    if (ctx.width < from || !inScope(ctx, row) || !visible(ctx, row)) continue;
    const kids = visibleChildren(ctx, row);
    if (kids.length < 2) continue;
    const first = kids[0].getBoundingClientRect();
    const broken = kids.slice(1).find((kid) => {
      const r = kid.getBoundingClientRect();
      return r.top >= first.bottom - 1 || r.bottom <= first.top + 1;
    });
    if (broken) finding(ctx, "wrapped", broken);
  }
}

// Centred: an empty state in the middle of its box.
// A grid or flex item owns its cell: its content is centred in its own box.
// A block is centred in its parent's content box.
function contentMiddle(ctx, el) {
  const r = el.getBoundingClientRect();
  const cs = style(ctx, el);
  return (r.left + Number.parseFloat(cs.borderLeftWidth) + Number.parseFloat(cs.paddingLeft) + r.right - Number.parseFloat(cs.borderRightWidth) - Number.parseFloat(cs.paddingRight)) / 2;
}

// How far the content is off the middle, or null when there is nothing to measure.
function centreOffset(ctx, el) {
  const parent = el.parentElement;
  if (!parent) return null;
  if (/grid|flex/.test(style(ctx, parent).display)) {
    const kids = visibleChildren(ctx, el).map((kid) => kid.getBoundingClientRect());
    if (kids.length === 0) return null;
    const at = (Math.min(...kids.map((k) => k.left)) + Math.max(...kids.map((k) => k.right))) / 2;
    return Math.round(at - contentMiddle(ctx, el));
  }
  const r = el.getBoundingClientRect();
  return Math.round((r.left + r.right) / 2 - contentMiddle(ctx, parent));
}

function checkCentred(ctx) {
  for (const el of marked(ctx, "centred", ctx.layout.centred)) {
    const by = centreOffset(ctx, el);
    if (by !== null && Math.abs(by) > 4) finding(ctx, "offCentre", el, { by });
  }
}

// Pairs: a label beside its value shares the baseline of the value's first line.
function baseline(ctx, el) {
  const run = ctx.runs.find((candidate) => el.contains(candidate.node));
  if (!run) return null;
  const ink = inkOf(ctx, style(ctx, run.el), run.node.textContent.trim());
  return run.raw.top + (run.raw.height - (ink.fAsc + ink.fDesc)) / 2 + ink.fAsc;
}

// The value's baseline minus the label's, or null when the pair is not one line.
function pairOffset(ctx, label, value) {
  if (!label || !value) return null;
  if (value.getBoundingClientRect().left < label.getBoundingClientRect().right - 1) return null;
  const l = baseline(ctx, label), v = baseline(ctx, value);
  return l === null || v === null ? null : Math.round((v - l) * 10) / 10;
}

function checkPairs(ctx) {
  for (const row of marked(ctx, "pair", ctx.layout.pairs)) {
    const [label, value] = row.children;
    const by = pairOffset(ctx, label, value);
    if (by !== null && Math.abs(by) > 1) finding(ctx, "misaligned", row, { by, text: label.textContent.trim().slice(0, 24) });
  }
}

// Rails: what starts a line inside a card starts on one edge.
function railStart(ctx, el) {
  const r = el.getBoundingClientRect();
  if (el.matches(".search, .t-field, [data-rail=box]")) return r.left;
  const cs = style(ctx, el);
  return r.left + Number.parseFloat(cs.borderLeftWidth) + Number.parseFloat(cs.paddingLeft);
}

// Every marked start counts; a terminal selector counts its first match.
function railEdges(ctx, container, starts, owns) {
  const edges = [];
  for (const selector of starts) {
    const found = Array.from(container.querySelectorAll(selector)).filter((candidate) => candidate.closest(owns) === container && visible(ctx, candidate));
    const each = selector === "[data-rail]";
    for (const el of each ? found : found.slice(0, 1)) edges.push({ what: each ? mark(el) : selector, x: Math.round(railStart(ctx, el)) });
  }
  return edges;
}

function checkRails(ctx) {
  const { rails } = ctx.layout;
  const starts = ["[data-rail]", ...rails.starts];
  const owns = ["[data-layout~=rail]", rails.containers].filter(Boolean).join(", ");
  for (const container of marked(ctx, "rail", rails.containers ? [rails.containers] : [])) {
    const edges = railEdges(ctx, container, starts, owns);
    if (edges.length < 2) continue;
    const edge = edges[0].x;
    const off = edges.filter((item) => Math.abs(item.x - edge) > 1);
    if (off.length > 0) finding(ctx, "offRail", container, { by: off.map((item) => `${item.what} ${signed(item.x - edge)}px`).join(", ") });
  }
}

// ---- Owner rules ---------------------------------------------------------

// Rule 2: a spread row keeps its start at the start edge and its end group at
// the end edge; nothing packed at one side with the other side empty.
function checkSpread(ctx) {
  for (const row of marked(ctx, "spread")) {
    const kids = visibleChildren(ctx, row);
    if (kids.length < 2) continue;
    const r = row.getBoundingClientRect();
    const cs = style(ctx, row);
    const inner = r.right - Number.parseFloat(cs.borderRightWidth) - Number.parseFloat(cs.paddingRight);
    const last = kids.at(-1).getBoundingClientRect();
    // A wrapped end group sits at the end of its own line.
    const gap = Math.round(inner - last.right);
    if (gap > 2) finding(ctx, "packed", kids.at(-1), { by: `${gap}px short of the end` });
  }
}

// Rule 3: a state is shown once in its scope: a card, a surface, one item
// of a list or the page's layer. A second mark of the same state, or the
// same word as plain text beside it, says it twice. In a row of a table,
// marks in two cells are two columns; only the word repeated as text counts.
// A bar or a rail is a layer of its own: the game's state in the top bar is not the page's.
function scopeOf(ctx, el) {
  return el.closest(SCOPES) ?? layerOf(ctx, el);
}

// The state labels of each scope; a mark said twice in one scope is a finding.
function statusLabels(ctx) {
  const labels = new Map();
  for (const el of document.querySelectorAll("[data-status]")) {
    if (!inScope(ctx, el) || !visible(ctx, el)) continue;
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
    if (!label) continue;
    const scope = scopeOf(ctx, el);
    if (!labels.has(scope)) labels.set(scope, new Set());
    if (labels.get(scope).has(label) && !scope.matches(ITEMS)) finding(ctx, "stateTwice", el, { by: label });
    labels.get(scope).add(label);
  }
  return labels;
}

function checkStateTwice(ctx) {
  const labels = statusLabels(ctx);
  for (const run of ctx.runs) {
    if (run.el.closest("[data-status]")) continue;
    const said = labels.get(scopeOf(ctx, run.el));
    const text = run.node.textContent.trim().toLowerCase();
    if (said && text.length > 2 && said.has(text)) finding(ctx, "stateTwice", run.el, { by: text });
  }
}

// Rule 4: rows share column tracks, labels are said once in the header, and
// a row has one action column in one button style.
function inkOfEl(ctx, el) {
  const rects = [];
  for (const run of ctx.runs) if (el.contains(run.node)) rects.push(run.r);
  for (const atom of ctx.atoms) if (atom.kind !== "text" && el.contains(atom.el)) rects.push(atom.r);
  if (rects.length === 0) return null;
  return { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) };
}

// A record (the phone layout) stacks its cells: it has no columns to share.
function isLined(ctx, row) {
  const cells = visibleChildren(ctx, row);
  if (cells.length < 2) return false;
  const a = cells[0].getBoundingClientRect(), b = cells[1].getBoundingClientRect();
  return b.top < a.bottom - 1 && a.top < b.bottom - 1;
}

function spreadOf(values) {
  return Math.max(...values) - Math.min(...values);
}

// How far one column drifts across the rows, with the cell to blame; null when it has too few cells.
function columnDrift(ctx, lined, index) {
  const cells = lined.map((row) => row.children[index]).filter((cell) => cell && visible(ctx, cell) && cell.getAttribute("colspan") === null);
  if (cells.length < 2) return null;
  const inks = cells.map((cell) => inkOfEl(ctx, cell)).filter(Boolean);
  if (inks.length < 2) return null;
  const drift = Math.min(spreadOf(inks.map((r) => r.left)), spreadOf(inks.map((r) => r.right)), spreadOf(inks.map((r) => (r.left + r.right) / 2)));
  return { cell: cells[0], drift };
}

function checkColumnDrift(ctx, lined) {
  if (lined.length < 2) return;
  const count = Math.max(...lined.map((row) => row.children.length));
  for (let index = 0; index < count; index += 1) {
    const found = columnDrift(ctx, lined, index);
    if (found && found.drift > 1.5) finding(ctx, "columns", found.cell, { by: `column ${index + 1} drifts ${Math.round(found.drift)}px` });
  }
}

function actionStyles(ctx, list) {
  const styles = new Set();
  for (const cell of list.querySelectorAll("[data-col=actions]")) {
    for (const control of cell.querySelectorAll("button, a[href]")) {
      if (visible(ctx, control) && control.closest("[role=menu]") === null) styles.add(String(control.className));
    }
  }
  return styles;
}

function checkActionColumn(ctx, list, body) {
  for (const row of body) {
    const actions = row.querySelectorAll("[data-col=actions]");
    if (actions.length > 1) finding(ctx, "columns", row, { by: `${actions.length} action columns` });
  }
  const styles = actionStyles(ctx, list);
  if (styles.size > 1) finding(ctx, "columns", list, { by: `${styles.size} button styles in the action column` });
}

// A label shares its cell with the value it names; a text that is the
// whole cell is a value, however often it repeats.
function isLabel(ctx, run) {
  const cell = run.el.closest("td, th, [role=cell]");
  return cell !== null && ctx.runs.some((other) => other.node !== run.node && cell.contains(other.node));
}

function rowLabels(ctx, row) {
  const texts = ctx.runs
    .filter((run) => row.contains(run.node) && !run.el.closest("[data-status], button, a, [data-col=actions]") && isLabel(ctx, run))
    .map((run) => run.node.textContent.trim())
    .filter((text) => text.length <= 20 && !/^[\d—–·:,./-]/.test(text));
  return new Set(texts);
}

function checkRepeatedLabel(ctx, list, body) {
  if (body.length < 3) return;
  const leafTexts = body.map((row) => rowLabels(ctx, row));
  const common = [...leafTexts[0]].filter((text) => leafTexts.every((set) => set.has(text)));
  if (common.length > 0) finding(ctx, "repeatedLabel", list, { by: common.slice(0, 3).join(", ") });
}

function checkRows(ctx) {
  for (const list of marked(ctx, "rows")) {
    const rows = Array.from(list.querySelectorAll("tr, [role=row]")).filter((row) => row.closest("[data-layout~=rows]") === list && visible(ctx, row));
    const body = rows.filter((row) => !row.closest("thead") && !row.querySelector("th, [role=columnheader]"));
    checkColumnDrift(ctx, body.filter((row) => isLined(ctx, row)));
    checkActionColumn(ctx, list, body);
    checkRepeatedLabel(ctx, list, body);
  }
}

// Rule 5: an icon beside its text sits on the text's centreline: halfway
// between the middles of the capitals and of the lower case.

// The gap between a run and the icon when the run sits beside it, else null.
function gapBeside(run, icon, ir) {
  if (run.layer !== icon.layer || !icon.el.parentElement.contains(run.node)) return null;
  if (run.raw.bottom <= ir.top || run.raw.top >= ir.bottom) return null;
  const dx = run.raw.left >= ir.right ? run.raw.left - ir.right : ir.left - run.raw.right;
  return dx < -1 || dx > 40 ? null : dx;
}

function textCentreline(ctx, run) {
  ctx.metrics.font = fontOf(style(ctx, run.el));
  const m = ctx.metrics.measureText("Hx");
  const cap = ctx.metrics.measureText("H").actualBoundingBoxAscent;
  const xh = ctx.metrics.measureText("x").actualBoundingBoxAscent;
  const base = run.raw.top + (run.raw.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
  return base - (cap + xh) / 4;
}

function nearestRun(ctx, icon, ir) {
  const middle = (ir.top + ir.bottom) / 2;
  let best = null;
  for (const run of ctx.runs) {
    const dx = gapBeside(run, icon, ir);
    if (dx === null || (best && dx >= best.dx)) continue;
    best = { dx, off: middle - textCentreline(ctx, run), text: run.text };
  }
  return best;
}

function checkIconLines(ctx) {
  for (const icon of ctx.atoms.filter((atom) => atom.kind === "icon")) {
    const ir = icon.el.getBoundingClientRect();
    if (ir.width > 32 || ir.height > 32 || !icon.el.parentElement) continue;
    const best = nearestRun(ctx, icon, ir);
    if (best && Math.abs(best.off) > 1) finding(ctx, "iconOffLine", icon.el, { by: `${best.off > 0 ? "+" : ""}${best.off.toFixed(1)}px`, text: best.text });
  }
}

// Rule 6: the breadcrumb is the title. Its last item is the one h1, and no
// heading, card title or tab repeats it or an earlier crumb.
function ownText(el) {
  return Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
}

function checkHeadings(ctx, trail, head) {
  const title = ownText(head).toLowerCase();
  const crumbs = new Set(Array.from(trail.querySelectorAll("a")).map((a) => a.textContent.trim().toLowerCase()));
  if (crumbs.has(title)) finding(ctx, "crumbRepeat", head, { by: "a crumb repeats the title" });
  for (const h of document.querySelectorAll("main h2, main h3, main legend, main [role=tab][aria-selected=true]")) {
    if (!visible(ctx, h) || !inScope(ctx, h) || h.closest("dialog")) continue;
    const text = ownText(h).toLowerCase() || h.textContent.trim().toLowerCase();
    if (text && (text === title || crumbs.has(text))) finding(ctx, "crumbRepeat", h, { by: `repeats “${text.slice(0, 24)}”` });
  }
}

function checkCrumbs(ctx) {
  for (const trail of document.querySelectorAll("[data-layout~=crumbs]")) {
    if (!inScope(ctx, trail) || !visible(ctx, trail)) continue;
    const heads = Array.from(document.querySelectorAll("main h1, [role=main] h1")).filter((h) => visible(ctx, h));
    if (heads.length === 1) checkHeadings(ctx, trail, heads[0]);
    else finding(ctx, "crumbRepeat", trail, { by: `${heads.length} h1` });
  }
}

// Rule 8: the cards of one grid row share one height, and from 1440px a
// row that is not the last of a wrapping grid reaches the grid's end edge.
function gridRowsOf(cells) {
  const rowsByTop = new Map();
  for (const cell of cells) {
    const top = Math.round(cell.getBoundingClientRect().top);
    const key = [...rowsByTop.keys()].find((t) => Math.abs(t - top) <= 1) ?? top;
    if (!rowsByTop.has(key)) rowsByTop.set(key, []);
    rowsByTop.get(key).push(cell);
  }
  return [...rowsByTop.values()];
}

function checkGridRow(ctx, row, atEnd, end) {
  const heights = row.map((cell) => cell.getBoundingClientRect().height);
  const differ = Math.max(...heights) - Math.min(...heights);
  if (differ > 1) finding(ctx, "cardHeights", row[0], { by: `${Math.round(differ)}px` });
  const last = Math.max(...row.map((cell) => cell.getBoundingClientRect().right));
  if (ctx.width >= 1440 && atEnd && end - last > 1) finding(ctx, "gridEdge", row.at(-1), { by: `${Math.round(end - last)}px short` });
}

function checkStretched(ctx, cells) {
  for (const cell of cells) {
    const r = cell.getBoundingClientRect();
    const ink = inkOfEl(ctx, cell);
    if (r.width > 480 && ink && (ink.right - ink.left) / r.width < 0.5) finding(ctx, "stretched", cell, { by: `${Math.round(((ink.right - ink.left) / r.width) * 100)}% covered` });
  }
}

function checkGrids(ctx) {
  for (const grid of marked(ctx, "grid")) {
    const cells = visibleChildren(ctx, grid);
    if (cells.length < 2) continue;
    const rowList = gridRowsOf(cells);
    const gr = grid.getBoundingClientRect();
    const gcs = style(ctx, grid);
    const end = gr.right - Number.parseFloat(gcs.paddingRight) - Number.parseFloat(gcs.borderRightWidth);
    rowList.forEach((row, index) => {
      if (row.length >= 2) checkGridRow(ctx, row, index < rowList.length - 1 || rowList.length === 1, end);
    });
    if (ctx.advise) checkStretched(ctx, cells);
  }
}

// Menus: inside the viewport, every label inside the menu and on one edge.
function checkMenuLabels(ctx, menu, m) {
  const starts = [];
  for (const item of menu.querySelectorAll(MENU_ITEMS)) {
    const run = ctx.runs.find((candidate) => item.contains(candidate.node));
    if (!run) continue;
    starts.push(run.raw.left);
    if (run.raw.right > m.right + 1 || run.raw.left < m.left - 1 || run.raw.right > run.r.right + 1) finding(ctx, "menuClipped", item, { text: run.text });
  }
  if (starts.length > 1 && spreadOf(starts) > 2) finding(ctx, "menuRagged", menu, { by: `${Math.round(spreadOf(starts))}px` });
}

function checkMenu(ctx) {
  const { root } = ctx;
  if (!root?.matches("[role=menu]")) return;
  const m = root.getBoundingClientRect();
  if (m.left < -1 || m.right > ctx.width + 1 || m.top < -1 || m.bottom > window.innerHeight + 1) {
    const b = box(m);
    finding(ctx, "menuCut", root, { by: `${b.x},${b.y} ${b.w}x${b.h}` });
  }
  checkMenuLabels(ctx, root, m);
}

// ---- Advisory: packing, copy, contrast -----------------------------------

function toRgb(value) {
  const m = /rgba?\(([^)]+)\)/.exec(String(value));
  if (!m) return null;
  const parts = m[1].split(",").map((p) => Number.parseFloat(p.trim()));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function lum(c) {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function effectiveBg(ctx, el) {
  for (let node = el; node; node = node.parentElement) {
    const c = toRgb(style(ctx, node).backgroundColor);
    if (c && c.a > 0.95) return c;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

function contrastRatio(fg, bg) {
  const c = fg.a < 1 ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) } : fg;
  const l1 = lum(c), l2 = lum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function isLargeText(cs) {
  const size = Number.parseFloat(cs.fontSize);
  return size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
}

function checkContrast(ctx) {
  const done = new Set();
  for (const run of ctx.runs) {
    if (done.has(run.el) || run.el.closest("[disabled], [aria-disabled=true], [aria-hidden=true]")) continue;
    done.add(run.el);
    const cs = style(ctx, run.el);
    const fg = toRgb(cs.color);
    if (!fg) continue;
    const ratio = contrastRatio(fg, effectiveBg(ctx, run.el));
    if (ratio < (isLargeText(cs) ? 3 : 4.5)) finding(ctx, "contrast", run.el, { by: `${ratio.toFixed(2)}:1`, text: run.text });
  }
}

// Rule 2, everywhere: a flex row whose content covers under half its width
// and leaves the end empty.
function checkLoosePacked(ctx) {
  for (const el of ctx.all) {
    const cs = style(ctx, el);
    if (!cs.display.includes("flex") || cs.flexDirection !== "row" || !visible(ctx, el) || !inScope(ctx, el)) continue;
    const kids = visibleChildren(ctx, el);
    const r = el.getBoundingClientRect();
    if (kids.length < 2 || r.width < 320) continue;
    const right = Math.max(...kids.map((kid) => kid.getBoundingClientRect().right));
    const left = Math.min(...kids.map((kid) => kid.getBoundingClientRect().left));
    if ((right - left) / r.width < 0.5 && r.right - right > r.width * 0.4) finding(ctx, "loosePacked", el, { by: `${Math.round(((right - left) / r.width) * 100)}% covered` });
  }
}

// Rule 1: a long or multi-line sentence outside a recovery slot.
function checkCopy(ctx) {
  for (const el of ctx.all) {
    if (!measurable(ctx, el) || el.closest(NO_COPY)) continue;
    const own = ownText(el);
    if (own.length > 55 && /\s/.test(own) && /[a-z]/.test(own)) finding(ctx, "copy", el, { text: own.slice(0, 60) });
  }
}
