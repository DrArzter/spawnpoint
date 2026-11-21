// The in-page probe. audit.mjs evaluates `(probe)(options)` in the page and
// reads back the findings. It runs in the browser: no imports, no Node.
//
// options: { width, coarse, layout, advise, surface }
// - width: the width the runner set; the layout viewport must not grow past it.
// - layout: selectors for skins without markers (LAYOUT in audit.mjs).
// - surface: a dialog, panel or menu is open; only its layer is measured.
// eslint-disable-next-line no-unused-vars
function probe(options) {
  const { width, coarse, layout, advise, surface } = options;
  // A menu is measured on its own: only what is inside it.
  const root = options.root ? document.querySelector(options.root) : null;
  const all = Array.from(document.querySelectorAll("body *"));
  const metrics = document.createElement("canvas").getContext("2d");
  const out = {
    wider: [], overflowing: [], sideways: [], overlaps: [], textOverText: [], wrapped: [], offCentre: [], misaligned: [], offRail: [],
    menuClipped: [], menuRagged: [], menuCut: [],
    packed: [], columns: [], repeatedLabel: [], iconOffLine: [], crumbRepeat: [], gridEdge: [], cardHeights: [], stateTwice: [],
    // Advisory only.
    clipped: [], smallTargets: [], contrast: [], loosePacked: [], copy: [], stretched: [],
  };

  // ---- Element helpers -----------------------------------------------------

  const styles = new Map();
  const style = (el) => { let cs = styles.get(el); if (!cs) { cs = getComputedStyle(el); styles.set(el, cs); } return cs; };
  const hiddenByTechnique = (el) => {
    const cs = style(el);
    return cs.clipPath === "inset(50%)" || el.closest(".visually-hidden, .c-sr, .sr-only") !== null;
  };
  const visible = (el, rect = el.getBoundingClientRect()) => {
    const cs = style(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    if (rect.width < 1 || rect.height < 1) return false;
    if (el.closest("[hidden], [inert]")) return false;
    // An ancestor at zero opacity hides its subtree.
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) if (Number(style(node).opacity) === 0) return false;
    return true;
  };
  // A stable name for an element: markers and roles, never a class path.
  const mark = (el) => {
    const bits = [];
    for (let node = el, depth = 0; node && node !== document.body && depth < 6 && bits.length < 3; node = node.parentElement, depth += 1) {
      const d = node.dataset ?? {};
      const label = node.getAttribute("aria-label");
      let bit = null;
      if (d.action) bit = `[data-action=${d.action}]`;
      else if (d.col) bit = `[data-col=${d.col}]`;
      else if (d.layout) bit = `[data-layout=${d.layout}]`;
      else if (d.layer) bit = `[data-layer=${d.layer}]`;
      else if (d.status) bit = `[data-status]`;
      else if (node.getAttribute("role") && node.getAttribute("role") !== "presentation") bit = `[role=${node.getAttribute("role")}]`;
      else if (depth === 0) bit = node.tagName.toLowerCase();
      if (bit && depth === 0 && label && !d.action) bit += `[aria-label]`;
      if (bit) bits.unshift(bit);
    }
    return bits.join(" ");
  };
  // The class path, for a person reading the report; keys use `mark`.
  const path = (el) => {
    const bits = [];
    for (let node = el, i = 0; node && i < 4; i += 1, node = node.parentElement) {
      const cls = typeof node.className === "string" && node.className ? "." + node.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
      bits.unshift(node.tagName.toLowerCase() + cls);
    }
    return bits.join(" > ");
  };
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.right - r.left), h: Math.round(r.bottom - r.top) });
  const finding = (kind, el, extra = {}) => {
    const r = el?.getBoundingClientRect?.();
    out[kind].push({ key: el ? mark(el) : "page", sel: el ? path(el) : "page", ...(r ? { box: box(r) } : {}), ...extra });
  };
  const scrollableAncestor = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const cs = style(node);
      if (cs.overflowX === "auto" || cs.overflowX === "scroll") return true;
    }
    return false;
  };

  // ---- Layers ----------------------------------------------------------------
  // A layer is what paints over the page as one surface: an open modal dialog,
  // an open popover, a fixed or sticky bar, or a box marked data-layer. Boxes
  // are compared only within one layer; the page under a sheet or a bar is not
  // a collision.
  const layers = new Map();
  const layerOf = (el) => {
    if (layers.has(el)) return layers.get(el);
    let layer;
    if (!el || el === document.body || el === document.documentElement) layer = document.body;
    else {
      const cs = style(el);
      const own = (el.matches("dialog[open]") || el.matches(":popover-open") || cs.position === "fixed" || cs.position === "sticky"
        || (el.dataset.layer && el.dataset.layer !== "glyph"));
      layer = own ? el : layerOf(el.parentElement);
    }
    layers.set(el, layer);
    return layer;
  };
  const modal = Array.from(document.querySelectorAll("dialog[open]")).find((d) => { try { return d.matches(":modal"); } catch { return false; } }) ?? null;
  // With a modal open the page is inert: only the dialog and what opens over it count.
  const inScope = (el) => {
    if (root) return root.contains(el);
    if (!modal) return true;
    if (modal.contains(el)) return true;
    const layer = layerOf(el);
    return layer !== document.body && !layer.contains(modal) && style(layer).position === "fixed" && layer.matches("[popover], [data-layer]");
  };

  // What of a box can be seen: inside the set width and every clipping box above it.
  const clipBoxes = new Map();
  const clipBox = (el) => {
    if (clipBoxes.has(el)) return clipBoxes.get(el);
    const parent = el.parentElement;
    let b = parent && parent !== document.documentElement ? clipBox(parent) : { left: 0, right: width, top: -Infinity, bottom: Infinity };
    if (parent && layerOf(el) === layerOf(parent)) {
      const pcs = style(parent);
      if (pcs.overflowX !== "visible" || pcs.overflowY !== "visible") {
        const r = parent.getBoundingClientRect();
        b = { left: Math.max(b.left, r.left), right: Math.min(b.right, r.right), top: Math.max(b.top, r.top), bottom: Math.min(b.bottom, r.bottom) };
      }
    } else if (parent) {
      b = { left: 0, right: width, top: -Infinity, bottom: Infinity };
    }
    clipBoxes.set(el, b);
    return b;
  };
  const seen = (r, el, within = false) => {
    let b = clipBox(el);
    const ecs = within ? style(el) : null;
    if (ecs && (ecs.overflowX !== "visible" || ecs.overflowY !== "visible")) {
      const own = el.getBoundingClientRect();
      b = { left: Math.max(b.left, own.left), right: Math.min(b.right, own.right), top: Math.max(b.top, own.top), bottom: Math.min(b.bottom, own.bottom) };
    }
    const s = { left: Math.max(r.left, b.left), right: Math.min(r.right, b.right), top: Math.max(r.top, b.top), bottom: Math.min(r.bottom, b.bottom) };
    return s.right - s.left > 0.5 && s.bottom - s.top > 0.5 ? s : null;
  };

  // ---- Text runs, by their ink ---------------------------------------------
  // A run's box is the font's whole ascent and descent. Its ink is narrower:
  // from the tallest glyph to the deepest descender, measured on the run's own
  // text. Two runs collide when their ink does.
  const fontOf = (cs) => `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const inkCache = new Map();
  const inkOf = (cs, text) => {
    const font = fontOf(cs);
    const key = font + "\u0000" + text;
    if (inkCache.has(key)) return inkCache.get(key);
    metrics.font = font;
    const m = metrics.measureText(text);
    const v = { asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent, fAsc: m.fontBoundingBoxAscent, fDesc: m.fontBoundingBoxDescent };
    inkCache.set(key, v);
    return v;
  };
  const runs = [];
  {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement;
      const text = node.textContent.trim();
      if (!text || !owner || owner.closest("script, style, noscript, [data-layer=glyph]")) continue;
      if (!visible(owner) || hiddenByTechnique(owner) || !inScope(owner)) continue;
      const cs = style(owner);
      const ink = inkOf(cs, text);
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        const r = seen(rect, owner, true);
        if (!r) continue;
        const base = rect.top + (rect.height - (ink.fAsc + ink.fDesc)) / 2 + ink.fAsc;
        const inkBox = { left: r.left, right: r.right, top: Math.max(r.top, base - ink.asc), bottom: Math.min(r.bottom, base + ink.desc) };
        if (inkBox.bottom - inkBox.top < 0.5) continue;
        runs.push({ kind: "text", node, el: owner, r: inkBox, raw: rect, text: text.slice(0, 30), layer: layerOf(owner) });
      }
    }
  }

  // ---- Atoms: what may not overlap -----------------------------------------
  // Text runs, icons and images, and boxes that paint: a control or a leaf
  // with a fill, a full outline or an image. A control that paints nothing is
  // there through its text and icons; a cell's bottom rule is not a box. An
  // aria-hidden mark is an atom like any other; only a glyph marked
  // data-layer="glyph" is laid over its control on purpose.
  const atoms = runs.slice();
  const CONTROL = "button, a[href], input, select, textarea, [role=button], [role=menuitem], [role=tab], summary";
  const paints = (cs) => {
    const bg = cs.backgroundColor;
    const fill = bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg);
    const outline = ["Top", "Right", "Bottom", "Left"].every((side) => parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== "none");
    return fill || outline || cs.backgroundImage !== "none";
  };
  for (const el of all) {
    if (el.closest("[data-layer=glyph], script, style")) continue;
    const isSvg = el.tagName.toLowerCase() === "svg" && !el.parentElement.closest("svg");
    const isMedia = el.matches("img, canvas, video");
    const isControl = el.matches(CONTROL);
    const isLeaf = !isSvg && !isMedia && !isControl && el.children.length === 0 && !(el instanceof SVGElement);
    if (!isSvg && !isMedia && !isControl && !isLeaf) continue;
    const rect = el.getBoundingClientRect();
    if (!visible(el, rect) || hiddenByTechnique(el) || !inScope(el)) continue;
    if ((isLeaf || isControl) && !paints(style(el))) continue;
    if (isLeaf && (rect.width < 3 || rect.height < 3)) continue;
    const r = seen(rect, el);
    if (!r) continue;
    atoms.push({ kind: isSvg ? "icon" : isMedia ? "image" : isControl ? "control" : "box", el, r, layer: layerOf(el) });
  }

  const cross = (a, b, by = 1) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > by && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > by;
  // Hit-testing: where the two meet, whatever paints on top must be one of them
  // or in their layer; a box hidden under another layer is not on the page.
  const hidden = (a, b) => {
    const x = (Math.max(a.r.left, b.r.left) + Math.min(a.r.right, b.r.right)) / 2;
    const y = (Math.max(a.r.top, b.r.top) + Math.min(a.r.bottom, b.r.bottom)) / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const top = document.elementFromPoint(x, y);
    if (!top) return false;
    const layer = layerOf(top);
    return layer !== a.layer && !a.layer.contains(layer);
  };
  const related = (a, b) => {
    const ea = a.el, eb = b.el;
    return ea === eb || ea.contains(eb) || eb.contains(ea);
  };
  const atomName = (a) => a.kind === "text" ? `“${a.text.slice(0, 14)}”` : a.kind;
  {
    const sorted = atoms.slice().sort((a, b) => a.r.top - b.r.top);
    const reported = new Set();
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      for (let j = i + 1; j < sorted.length && sorted[j].r.top < a.r.bottom; j++) {
        const b = sorted[j];
        if (a.layer !== b.layer || related(a, b)) continue;
        if (a.kind === "text" && b.kind === "text" && a.node === b.node) continue;
        if (!cross(a.r, b.r)) continue;
        if (hidden(a, b)) continue;
        const kind = a.kind === "text" && b.kind === "text" ? "textOverText" : "overlaps";
        const at = b.kind === "text" ? b.el : b.el;
        const key = mark(at) + "|" + mark(a.el);
        if (reported.has(key)) continue;
        reported.add(key);
        out[kind].push({ key: mark(at), sel: path(at), with: path(a.el), by: `${atomName(b)} on ${atomName(a)}`, box: box({ left: Math.min(a.r.left, b.r.left), top: Math.min(a.r.top, b.r.top), right: Math.max(a.r.right, b.r.right), bottom: Math.max(a.r.bottom, b.r.bottom) }) });
      }
    }
  }

  // ---- The page at the width it was given ----------------------------------
  // Under mobile emulation a page wider than the phone widens the layout
  // viewport with it, so innerWidth is no reference. The runner's width is.
  const docWidth = document.documentElement.scrollWidth;
  if ((docWidth > width + 1 || window.innerWidth > width + 1)) {
    out.wider.push({ key: "page", sel: "html", by: `${Math.max(docWidth, window.innerWidth) - width}px` });
  }
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (!visible(el, rect) || hiddenByTechnique(el) || !inScope(el)) continue;
    const cs = style(el);
    // Past either edge, with no scroll box to excuse it. A drawer parked wholly
    // off the edge is closed, not overflowing.
    const pastRight = rect.right > width + 1 && rect.left < width - 1;
    const pastLeft = rect.left < -1 && rect.right > 1;
    if ((pastRight || pastLeft) && !scrollableAncestor(el)) {
      const parent = el.parentElement;
      const pr = parent?.getBoundingClientRect();
      // Report the outermost box that sticks out, not each of its children.
      const parentOut = parent && pr && ((pr.right > width + 1 && pr.left < width - 1) || (pr.left < -1 && pr.right > 1)) && visible(parent, pr);
      if (!parentOut) finding("overflowing", el, { by: pastRight ? `+${Math.round(rect.right - width)}px` : `${Math.round(rect.left)}px` });
    }
    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1 && el.dataset.scroll !== "expected") {
      finding("sideways", el, { by: el.scrollWidth - el.clientWidth });
    }
    if (advise) {
      if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX === "hidden" && cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.textContent.trim()) {
        finding("clipped", el, { text: el.textContent.trim().slice(0, 40) });
      }
      const floor = coarse ? 32 : 24;
      if (el.matches(CONTROL) && (rect.width < floor || rect.height < floor) && cs.display !== "contents" && !el.closest("[aria-disabled=true], [disabled]")) {
        finding("smallTargets", el, { by: `${Math.round(rect.width)}x${Math.round(rect.height)}` });
      }
    }
  }

  // ---- Layout promises -----------------------------------------------------
  const marked = (name, selectors = []) => {
    const set = new Set(document.querySelectorAll(`[data-layout~="${name}"]`));
    for (const sel of selectors) for (const el of document.querySelectorAll(sel)) set.add(el);
    return Array.from(set).filter((el) => inScope(el) && visible(el));
  };

  // One line: a row that promised one line and broke it.
  const oneLine = [...document.querySelectorAll("[data-layout~=one-line]")].map((el) => [el, Number(el.dataset.from ?? 0)]);
  for (const [sel, from] of layout.oneLine) for (const el of document.querySelectorAll(sel)) oneLine.push([el, from]);
  for (const [row, from] of oneLine) {
    if (width < from || !inScope(row) || !visible(row)) continue;
    const kids = Array.from(row.children).filter((kid) => visible(kid));
    if (kids.length < 2) continue;
    const first = kids[0].getBoundingClientRect();
    const broken = kids.slice(1).find((kid) => { const r = kid.getBoundingClientRect(); return r.top >= first.bottom - 1 || r.bottom <= first.top + 1; });
    if (broken) finding("wrapped", broken);
  }

  // Centred: an empty state in the middle of its box.
  // A grid or flex item owns its cell: its content is centred in its own box.
  // A block is centred in its parent's content box.
  const contentMiddle = (el) => {
    const r = el.getBoundingClientRect();
    const cs = style(el);
    return (r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight)) / 2;
  };
  for (const el of marked("centred", layout.centred)) {
    const parent = el.parentElement;
    if (!parent) continue;
    const item = /grid|flex/.test(style(parent).display);
    let middle, at;
    if (item) {
      const kids = Array.from(el.children).filter((kid) => visible(kid)).map((kid) => kid.getBoundingClientRect());
      if (kids.length === 0) continue;
      at = (Math.min(...kids.map((k) => k.left)) + Math.max(...kids.map((k) => k.right))) / 2;
      middle = contentMiddle(el);
    } else {
      const r = el.getBoundingClientRect();
      at = (r.left + r.right) / 2;
      middle = contentMiddle(parent);
    }
    const by = Math.round(at - middle);
    if (Math.abs(by) > 4) finding("offCentre", el, { by });
  }

  // Pairs: a label beside its value shares the baseline of the value's first line.
  const firstRun = (el) => runs.find((run) => el.contains(run.node));
  const baseline = (el) => {
    const run = firstRun(el);
    if (!run) return null;
    const ink = inkOf(style(run.el), run.node.textContent.trim());
    return run.raw.top + (run.raw.height - (ink.fAsc + ink.fDesc)) / 2 + ink.fAsc;
  };
  for (const row of marked("pair", layout.pairs)) {
    const [label, value] = row.children;
    if (!label || !value) continue;
    if (value.getBoundingClientRect().left < label.getBoundingClientRect().right - 1) continue;
    const l = baseline(label), v = baseline(value);
    if (l === null || v === null) continue;
    const by = Math.round((v - l) * 10) / 10;
    if (Math.abs(by) > 1) finding("misaligned", row, { by, text: label.textContent.trim().slice(0, 24) });
  }

  // Rails: what starts a line inside a card starts on one edge.
  const start = (el) => {
    const r = el.getBoundingClientRect();
    if (el.matches(".search, .t-field, [data-rail=box]")) return r.left;
    const cs = style(el);
    return r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  };
  const railContainers = marked("rail", layout.rails.containers ? [layout.rails.containers] : []);
  const railStarts = ["[data-rail]", ...layout.rails.starts];
  const railOf = (el) => el.closest(["[data-layout~=rail]", layout.rails.containers].filter(Boolean).join(", "));
  for (const container of railContainers) {
    const edges = [];
    for (const selector of railStarts) {
      const el = Array.from(container.querySelectorAll(selector)).find((candidate) => railOf(candidate) === container && visible(candidate));
      if (el) edges.push({ what: selector, x: Math.round(start(el)) });
    }
    if (edges.length < 2) continue;
    const edge = edges[0].x;
    const off = edges.filter((item) => Math.abs(item.x - edge) > 1);
    if (off.length > 0) finding("offRail", container, { by: off.map((item) => `${item.what} ${item.x - edge > 0 ? "+" : ""}${item.x - edge}px`).join(", ") });
  }

  // ---- Owner rules ---------------------------------------------------------

  // Rule 2: a spread row keeps its start at the start edge and its end group at
  // the end edge; nothing packed at one side with the other side empty.
  for (const row of marked("spread")) {
    const kids = Array.from(row.children).filter((kid) => visible(kid));
    if (kids.length < 2) continue;
    const r = row.getBoundingClientRect();
    const cs = style(row);
    const inner = r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
    const last = kids.at(-1).getBoundingClientRect();
    // A wrapped end group sits at the end of its own line.
    const gap = Math.round(inner - last.right);
    if (gap > 2) finding("packed", kids.at(-1), { by: `${gap}px short of the end` });
  }

  // Rule 3: a state is shown once in its scope: a card, a surface, one item
  // of a list or the page's layer. A second mark of the same state, or the
  // same word as plain text beside it, says it twice. In a row of a table,
  // marks in two cells are two columns; only the word repeated as text counts.
  {
    const ITEMS = "[data-layout~=rows] tr, [data-layout~=rows] [role=row], [role=listitem], li, [role=option], [role=radio], [role=menuitem], button, a[href]";
    const SCOPES = `${ITEMS}, [data-scope], dialog, [role=menu]`;
    // A bar or a rail is a layer of its own: the game's state in the top bar is not the page's.
    const scopeOf = (el) => el.closest(SCOPES) ?? layerOf(el);
    const labels = new Map();
    for (const el of document.querySelectorAll("[data-status]")) {
      if (!inScope(el) || !visible(el)) continue;
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
      if (!label) continue;
      const scope = scopeOf(el);
      if (!labels.has(scope)) labels.set(scope, new Set());
      if (labels.get(scope).has(label) && !scope.matches(ITEMS)) finding("stateTwice", el, { by: label });
      labels.get(scope).add(label);
    }
    for (const run of runs) {
      if (run.el.closest("[data-status]")) continue;
      const said = labels.get(scopeOf(run.el));
      const text = run.node.textContent.trim().toLowerCase();
      if (said && text.length > 2 && said.has(text)) finding("stateTwice", run.el, { by: text });
    }
  }

  // Rule 4: rows share column tracks, labels are said once in the header, and
  // a row has one action column in one button style.
  const inkOfEl = (el) => {
    const rects = [];
    for (const run of runs) if (el.contains(run.node)) rects.push(run.r);
    for (const atom of atoms) if (atom.kind !== "text" && el.contains(atom.el)) rects.push(atom.r);
    if (rects.length === 0) return null;
    return { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) };
  };
  for (const list of marked("rows")) {
    const rows = Array.from(list.querySelectorAll("tr, [role=row]")).filter((row) => row.closest("[data-layout~=rows]") === list && visible(row));
    const body = rows.filter((row) => !row.closest("thead") && !row.querySelector("th, [role=columnheader]"));
    // A record (the phone layout) stacks its cells: it has no columns to share.
    const lined = body.filter((row) => {
      const cells = Array.from(row.children).filter((cell) => visible(cell));
      if (cells.length < 2) return false;
      const a = cells[0].getBoundingClientRect(), b = cells[1].getBoundingClientRect();
      return b.top < a.bottom - 1 && a.top < b.bottom - 1;
    });
    if (lined.length >= 2) {
      const count = Math.max(...lined.map((row) => row.children.length));
      for (let index = 0; index < count; index += 1) {
        const cells = lined.map((row) => row.children[index]).filter((cell) => cell && visible(cell) && cell.getAttribute("colspan") === null);
        if (cells.length < 2) continue;
        const inks = cells.map(inkOfEl).filter(Boolean);
        if (inks.length < 2) continue;
        const spread = (values) => Math.max(...values) - Math.min(...values);
        const drift = Math.min(spread(inks.map((r) => r.left)), spread(inks.map((r) => r.right)), spread(inks.map((r) => (r.left + r.right) / 2)));
        if (drift > 1.5) finding("columns", cells[0], { by: `column ${index + 1} drifts ${Math.round(drift)}px` });
      }
    }
    for (const row of body) {
      const actions = row.querySelectorAll("[data-col=actions]");
      if (actions.length > 1) finding("columns", row, { by: `${actions.length} action columns` });
    }
    const styles = new Set();
    for (const cell of list.querySelectorAll("[data-col=actions]")) {
      for (const control of cell.querySelectorAll("button, a[href]")) if (visible(control) && control.closest("[role=menu]") === null) styles.add(String(control.className));
    }
    if (styles.size > 1) finding("columns", list, { by: `${styles.size} button styles in the action column` });
    if (body.length >= 3) {
      // A label shares its cell with the value it names; a text that is the
      // whole cell is a value, however often it repeats.
      const cellOf = (el) => el.closest("td, th, [role=cell]");
      const labelled = (run) => {
        const cell = cellOf(run.el);
        return cell !== null && runs.some((other) => other.node !== run.node && cell.contains(other.node));
      };
      const leafTexts = body.map((row) => new Set(runs.filter((run) => row.contains(run.node) && !run.el.closest("[data-status], button, a, [data-col=actions]") && labelled(run))
        .map((run) => run.node.textContent.trim()).filter((text) => text.length <= 20 && !/^[\d—–·:,./-]/.test(text))));
      const common = [...leafTexts[0]].filter((text) => leafTexts.every((set) => set.has(text)));
      if (common.length > 0) finding("repeatedLabel", list, { by: common.slice(0, 3).join(", ") });
    }
  }

  // Rule 5: an icon beside its text sits on the text's centreline: halfway
  // between the middles of the capitals and of the lower case.
  for (const icon of atoms.filter((atom) => atom.kind === "icon")) {
    const ir = icon.el.getBoundingClientRect();
    if (ir.width > 32 || ir.height > 32 || !icon.el.parentElement) continue;
    const middle = (ir.top + ir.bottom) / 2;
    let best = null;
    for (const run of runs) {
      if (run.layer !== icon.layer || !icon.el.parentElement.contains(run.node)) continue;
      if (run.raw.bottom <= ir.top || run.raw.top >= ir.bottom) continue;
      const dx = run.raw.left >= ir.right ? run.raw.left - ir.right : ir.left - run.raw.right;
      if (dx < -1 || dx > 40) continue;
      if (best && dx >= best.dx) continue;
      const cs = style(run.el);
      metrics.font = fontOf(cs);
      const m = metrics.measureText("Hx");
      const cap = metrics.measureText("H").actualBoundingBoxAscent;
      const xh = metrics.measureText("x").actualBoundingBoxAscent;
      const base = run.raw.top + (run.raw.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
      best = { dx, off: middle - (base - (cap + xh) / 4), text: run.text };
    }
    if (best && Math.abs(best.off) > 1) finding("iconOffLine", icon.el, { by: `${best.off > 0 ? "+" : ""}${best.off.toFixed(1)}px`, text: best.text });
  }

  // Rule 6: the breadcrumb is the title. Its last item is the one h1, and no
  // heading, card title or tab repeats it or an earlier crumb.
  for (const trail of document.querySelectorAll("[data-layout~=crumbs]")) {
    if (!inScope(trail) || !visible(trail)) continue;
    const heads = Array.from(document.querySelectorAll("main h1, [role=main] h1")).filter((h) => visible(h));
    if (heads.length !== 1) { finding("crumbRepeat", trail, { by: `${heads.length} h1` }); continue; }
    const own = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim().toLowerCase();
    const title = own(heads[0]);
    const crumbs = Array.from(trail.querySelectorAll("a")).map((a) => a.textContent.trim().toLowerCase());
    if (crumbs.includes(title)) finding("crumbRepeat", heads[0], { by: "a crumb repeats the title" });
    for (const h of document.querySelectorAll("main h2, main h3, main legend, main [role=tab][aria-selected=true]")) {
      if (!visible(h) || !inScope(h) || h.closest("dialog")) continue;
      const text = own(h) || h.textContent.trim().toLowerCase();
      if (text && (text === title || crumbs.includes(text))) finding("crumbRepeat", h, { by: `repeats “${text.slice(0, 24)}”` });
    }
  }

  // Rule 8: the cards of one grid row share one height, and from 1440px a
  // row that is not the last of a wrapping grid reaches the grid's end edge.
  for (const grid of marked("grid")) {
    const cells = Array.from(grid.children).filter((cell) => visible(cell));
    if (cells.length < 2) continue;
    const rowsByTop = new Map();
    for (const cell of cells) {
      const top = Math.round(cell.getBoundingClientRect().top);
      const key = [...rowsByTop.keys()].find((t) => Math.abs(t - top) <= 1) ?? top;
      if (!rowsByTop.has(key)) rowsByTop.set(key, []);
      rowsByTop.get(key).push(cell);
    }
    const rowList = [...rowsByTop.values()];
    const gr = grid.getBoundingClientRect();
    const gcs = style(grid);
    const end = gr.right - parseFloat(gcs.paddingRight) - parseFloat(gcs.borderRightWidth);
    rowList.forEach((row, index) => {
      if (row.length < 2) return;
      const heights = row.map((cell) => cell.getBoundingClientRect().height);
      if (Math.max(...heights) - Math.min(...heights) > 1) finding("cardHeights", row[0], { by: `${Math.round(Math.max(...heights) - Math.min(...heights))}px` });
      const last = Math.max(...row.map((cell) => cell.getBoundingClientRect().right));
      if (width >= 1440 && (index < rowList.length - 1 || rowList.length === 1) && end - last > 1) finding("gridEdge", row.at(-1), { by: `${Math.round(end - last)}px short` });
    });
    if (advise) {
      for (const cell of cells) {
        const r = cell.getBoundingClientRect();
        const ink = inkOfEl(cell);
        if (r.width > 480 && ink && (ink.right - ink.left) / r.width < 0.5) finding("stretched", cell, { by: `${Math.round(((ink.right - ink.left) / r.width) * 100)}% covered` });
      }
    }
  }

  // Menus: inside the viewport, every label inside the menu and on one edge.
  if (root && root.matches("[role=menu]")) {
    const m = root.getBoundingClientRect();
    if (m.left < -1 || m.right > width + 1 || m.top < -1 || m.bottom > window.innerHeight + 1) finding("menuCut", root, { by: `${box(m).x},${box(m).y} ${box(m).w}x${box(m).h}` });
    const starts = [];
    for (const item of root.querySelectorAll("[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]")) {
      const run = runs.find((candidate) => item.contains(candidate.node));
      if (!run) continue;
      starts.push(run.raw.left);
      if (run.raw.right > m.right + 1 || run.raw.left < m.left - 1 || run.raw.right > run.r.right + 1) finding("menuClipped", item, { text: run.text });
    }
    if (starts.length > 1 && Math.max(...starts) - Math.min(...starts) > 2) finding("menuRagged", root, { by: `${Math.round(Math.max(...starts) - Math.min(...starts))}px` });
  }

  // ---- Advisory: packing, copy, contrast -----------------------------------
  if (advise) {
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
    const effectiveBg = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const c = toRgb(style(node).backgroundColor);
        if (c && c.a > 0.95) return c;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const contrastSeen = new Set();
    for (const run of runs) {
      if (contrastSeen.has(run.el) || run.el.closest("[disabled], [aria-disabled=true]")) continue;
      contrastSeen.add(run.el);
      const cs = style(run.el);
      const fg = toRgb(cs.color);
      if (!fg) continue;
      const bg = effectiveBg(run.el);
      const c = fg.a < 1 ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) } : fg;
      const l1 = lum(c), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) finding("contrast", run.el, { by: `${ratio.toFixed(2)}:1`, text: run.text });
    }
    // Rule 2, everywhere: a flex row whose content covers under half its width
    // and leaves the end empty.
    for (const el of all) {
      const cs = style(el);
      if (!cs.display.includes("flex") || cs.flexDirection !== "row" || !visible(el) || !inScope(el)) continue;
      const kids = Array.from(el.children).filter((kid) => visible(kid));
      if (kids.length < 2) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 320) continue;
      const right = Math.max(...kids.map((kid) => kid.getBoundingClientRect().right));
      const left = Math.min(...kids.map((kid) => kid.getBoundingClientRect().left));
      if ((right - left) / r.width < 0.5 && r.right - right > r.width * 0.4) finding("loosePacked", el, { by: `${Math.round(((right - left) / r.width) * 100)}% covered` });
    }
    // Rule 1: a long or multi-line sentence outside a recovery slot.
    for (const el of all) {
      if (!visible(el) || !inScope(el) || el.closest("[data-copy=recovery], [role=alert], table, [role=table], pre, code, [data-layer=terminal], .c-terminal, .t-console")) continue;
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      if (own.length > 55 && /\s/.test(own) && /[a-z]/.test(own)) finding("copy", el, { text: own.slice(0, 60) });
    }
  }

  return out;
}
