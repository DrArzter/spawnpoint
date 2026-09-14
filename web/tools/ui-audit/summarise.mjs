// Roll 100+ probes up into findings, each with the routes and widths that show it.
import { readFileSync } from "node:fs";

const probes = JSON.parse(readFileSync(new URL("../../audit-light.json", import.meta.url), "utf8"));
// The steps DESIGN.md records. Keep this in step with its typography block.
const RAMP = new Set(["44/52", "32/40", "28/36", "24/32", "22/28", "20/28", "20/24", "18/24", "16/24", "14/22", "14/20", "13/18", "13/20", "12/16"]);
const RADII = new Set(["0px", "2px", "3px", "4px", "8px", "10px", "12px", "20px", "999px", "50%"]);

const group = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const k = key(row);
    const entry = map.get(k) ?? { count: 0, where: new Set(), sample: row };
    entry.count += 1;
    entry.where.add(`${row.route}@${row.width}`);
    map.set(k, entry);
  }
  return [...map.entries()].sort((a, b) => b[1].where.size - a[1].where.size);
};

const flat = (field) => probes.flatMap((p) => (p[field] ?? []).map((item) => ({ ...item, route: p.route, width: p.width })));

const errors = probes.filter((p) => p.error);
if (errors.length) console.log(`PROBE ERRORS: ${errors.length}`);

console.log(`\n### probes: ${probes.length} (${new Set(probes.map((p) => p.route)).size} routes x ${new Set(probes.map((p) => p.width)).size} widths)`);

const docOverflow = probes.filter((p) => p.docScrollWidth > p.viewportWidth + 1);
console.log(`\n## 1. Page scrolls sideways: ${docOverflow.length}`);
for (const p of docOverflow) console.log(`   ${p.route}@${p.width}: scrollWidth ${p.docScrollWidth}`);

console.log(`\n## 2. Elements past the viewport edge`);
for (const [sel, e] of group(flat("overflowing"), (r) => r.sel).slice(0, 12)) {
  console.log(`   [${e.where.size} views] ${sel}\n      right=${e.sample.right} vs viewport, seen: ${[...e.where].slice(0, 6).join(", ")}`);
}

console.log(`\n## 3. Text cut with no ellipsis`);
for (const [sel, e] of group(flat("clipped"), (r) => `${r.sel} :: ${r.text}`).slice(0, 12)) {
  console.log(`   [${e.where.size} views] ${sel}\n      ${e.sample.scroll}px into ${e.sample.client}px, seen: ${[...e.where].slice(0, 6).join(", ")}`);
}

console.log(`\n## 4. Touch targets under 32px`);
for (const [sel, e] of group(flat("smallTargets"), (r) => `${r.sel} :: ${r.label}`).slice(0, 12)) {
  console.log(`   [${e.where.size} views] ${e.sample.w}x${e.sample.h} ${sel} "${e.sample.label}"  ${[...e.where].slice(0, 4).join(", ")}`);
}

console.log(`\n## 5. Contrast below WCAG AA`);
for (const [sel, e] of group(flat("contrast"), (r) => `${r.sel} :: ${r.color} on ${r.bg}`).slice(0, 12)) {
  console.log(`   [${e.where.size} views] ratio ${e.sample.ratio} ${e.sample.size} ${sel}\n      "${e.sample.text}" ${e.sample.color} on ${e.sample.bg}`);
}

console.log(`\n## 6. Shadow on a persistent surface`);
for (const [sel, e] of group(flat("shadows"), (r) => r.sel).slice(0, 10)) {
  console.log(`   [${e.where.size} views] ${sel} — ${e.sample.shadow}`);
}

const fonts = new Map();
for (const p of probes) for (const [key, value] of Object.entries(p.fonts ?? {})) {
  const [size, line, weight] = key.split("/");
  const short = `${parseFloat(size)}/${parseFloat(line)}`;
  const entry = fonts.get(`${short}/${weight}`) ?? { count: 0, samples: new Set(), onRamp: RAMP.has(short) };
  entry.count += value.count;
  for (const sample of value.samples) entry.samples.add(sample);
  fonts.set(`${short}/${weight}`, entry);
}
console.log(`\n## 7. Type ramp — steps off DESIGN.md`);
for (const [key, e] of [...fonts].sort((a, b) => b[1].count - a[1].count)) {
  if (e.onRamp) continue;
  console.log(`   ${key} (${e.count} nodes) e.g. ${[...e.samples].slice(0, 2).join(" | ")}`);
}
console.log(`   on-ramp steps in use: ${[...fonts].filter(([, e]) => e.onRamp).map(([k]) => k).join(", ")}`);

const radii = new Map();
for (const p of probes) for (const [key, value] of Object.entries(p.radii ?? {})) {
  const entry = radii.get(key) ?? { count: 0, samples: new Set() };
  entry.count += value.count;
  for (const sample of value.samples) entry.samples.add(sample);
  radii.set(key, entry);
}
console.log(`\n## 8. Radii off the shape scale`);
for (const [key, e] of [...radii].sort((a, b) => b[1].count - a[1].count)) {
  if (key.split(" ").every((part) => RADII.has(part))) continue;
  console.log(`   ${key} (${e.count}) e.g. ${[...e.samples].slice(0, 2).join(" | ")}`);
}

const zed = new Map();
for (const p of probes) for (const [key, value] of Object.entries(p.zIndex ?? {})) {
  const entry = zed.get(key) ?? { count: 0, samples: new Set() };
  entry.count += value.count;
  for (const sample of value.samples) entry.samples.add(sample);
  zed.set(key, entry);
}
console.log(`\n## 9. z-index vocabulary`);
for (const [key, e] of [...zed].sort((a, b) => Number(b[0]) - Number(a[0]))) console.log(`   ${key}: ${[...e.samples].slice(0, 2).join(" | ")}`);

const families = new Map();
for (const p of probes) for (const [key, value] of Object.entries(p.fontFamilies ?? {})) {
  families.set(key, (families.get(key) ?? 0) + value.count);
}
console.log(`\n## 10. Font faces in use: ${[...families].map(([k, v]) => `${k} (${v})`).join(", ")}`);
