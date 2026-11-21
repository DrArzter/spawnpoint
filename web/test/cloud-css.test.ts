import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { MOTION } from "../src/skins/cloud/ui/motion.ts";

// The cloud skin's sheets keep the rules AGENTS.md sets for a face's CSS and
// the ones its spec adds (skin-spec §1.6, §7, R13): every styled c-* class has
// a consumer; no selector sets one property twice in one cascade context;
// every rule is scoped to the skin; times, easings and colours live only in
// tokens.css; the timers in motion.ts equal their tokens.

const root = new URL("../src/", import.meta.url).pathname;
const styles = join(root, "skins/cloud/styles");
const sheets = readdirSync(styles).filter((name) => name.endsWith(".css") && name !== "index.css").map((name) => ({ name, text: readFileSync(join(styles, name), "utf8") }));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

const code = sources(join(root, "skins/cloud")).join("\n");

// Commas inside :is() or :not() do not separate selectors.
function selectorList(head: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of head) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; } else current += ch;
  }
  return [...parts, current.trim()];
}

type Rule = Readonly<{ sheet: string; context: string; selectors: readonly string[]; line: number; declarations: ReadonlyMap<string, string> }>;

// Enough of a parser for hand-written sheets: comments out, at-rules as a
// context stack, declarations split on semicolons.
function rules(sheet: string, text: string): Rule[] {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found: Rule[] = [];
  const stack: ({ kind: "context"; head: string } | { kind: "rule"; declarations: Map<string, string> })[] = [];
  let buffer = "";
  let line = 1;
  let start = 1;
  let depth = 0;
  const declare = () => {
    const top = stack.at(-1);
    const body = buffer.trim();
    const colon = body.indexOf(":");
    if (top?.kind === "rule" && colon > 0) top.declarations.set(body.slice(0, colon).trim(), body.slice(colon + 1).trim());
  };
  for (const ch of source) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "{") {
      const head = buffer.trim();
      if (head.startsWith("@")) stack.push({ kind: "context", head });
      else {
        const declarations = new Map<string, string>();
        const context = stack.filter((entry) => entry.kind === "context").map((entry) => (entry as { head: string }).head).join(" | ");
        found.push({ sheet, context, selectors: selectorList(head), line: start, declarations });
        stack.push({ kind: "rule", declarations });
      }
      buffer = "";
    } else if (ch === "}") {
      declare();
      stack.pop();
      buffer = "";
    } else if (ch === ";" && depth === 0) {
      declare();
      buffer = "";
    } else {
      if (buffer.trim() === "" && !/\s/.test(ch)) start = line;
      buffer += ch;
    }
    if (ch === "\n") line += 1;
  }
  return found;
}

const all = sheets.flatMap((sheet) => rules(sheet.name, sheet.text)).filter((rule) => !rule.context.includes("keyframes"));

test("every c-* class the cloud sheets style is used by the cloud skin", () => {
  const defined = new Set(sheets.flatMap((sheet) => [...sheet.text.matchAll(/\.(c-[a-z0-9-]+)/g)].map((match) => match[1] as string)));
  // A class built from a template literal (`c-tone-${tone}`) is used by its prefix.
  const prefixes = [...code.matchAll(/(c-[a-z0-9-]+-)\$\{/g)].map((match) => match[1] as string);
  const dead = [...defined].filter((name) => {
    if (prefixes.some((prefix) => name.startsWith(prefix))) return false;
    return !new RegExp(`(?<![a-z0-9-])${name}(?![a-z0-9-])`).test(code);
  });
  assert.deepEqual(dead, [], `styled but never rendered: ${dead.join(", ")}`);
});

test("no selector sets the same property twice in one cascade context", () => {
  const seen = new Map<string, Rule[]>();
  for (const rule of all) {
    for (const selector of rule.selectors) {
      const key = `${rule.context} || ${selector}`;
      seen.set(key, [...(seen.get(key) ?? []), rule]);
    }
  }
  const clashes: string[] = [];
  for (const [key, list] of seen) {
    list.forEach((earlier, index) => {
      for (const later of list.slice(index + 1)) {
        for (const property of earlier.declarations.keys()) {
          if (later.declarations.has(property)) clashes.push(`${key.split(" || ")[1]} ${property}: ${earlier.sheet}:${earlier.line} then ${later.sheet}:${later.line}`);
        }
      }
    });
  }
  assert.deepEqual(clashes, [], `consolidate into one base rule:\n${clashes.join("\n")}`);
});

test("every cloud rule is scoped to the skin", () => {
  const loose = all.flatMap((rule) => rule.selectors.filter((selector) => !selector.startsWith('html[data-skin="cloud"]')).map((selector) => `${rule.sheet}:${rule.line} ${selector}`));
  assert.deepEqual(loose, []);
});

test("times, easings and colours are tokens, defined only in tokens.css", () => {
  const literals: string[] = [];
  for (const rule of all.filter((item) => item.sheet !== "tokens.css")) {
    for (const [property, value] of rule.declarations) {
      if (/(^|[\s,(])\d*\.?\d+m?s\b/.test(value) || value.includes("cubic-bezier(")) literals.push(`${rule.sheet}:${rule.line} ${property}: ${value}`);
      if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value)) literals.push(`${rule.sheet}:${rule.line} ${property}: ${value}`);
    }
  }
  assert.deepEqual(literals, []);
});

test("the timers in motion.ts equal their tokens", () => {
  const tokens = readFileSync(join(styles, "tokens.css"), "utf8");
  for (const [name, ms] of Object.entries(MOTION)) {
    const match = tokens.match(new RegExp(`${name}:\\s*([\\d.]+)(ms|s);`));
    assert.ok(match, `${name} is a token`);
    assert.equal(Number(match[1]) * (match[2] === "s" ? 1000 : 1), ms, name);
  }
  const timers = sources(join(root, "skins/cloud")).filter((text) => /set(Timeout|Interval)\([^,]+,\s*\d/.test(text));
  assert.equal(timers.length, 0, "a cloud timer reads its length from motion.ts");
});
