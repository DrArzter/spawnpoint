import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// AGENTS.md holds terminal.css to two rules a screenshot cannot check: every
// t-* class it styles has a consumer, and a selector never overwrites its own
// property in the same cascade context. A later rule that cancels an earlier
// one is how the next screen inherits a value nobody meant.

const root = new URL("../src/", import.meta.url).pathname;
const css = readFileSync(join(root, "skins/terminal/terminal.css"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|html)$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

const code = [...sources(root), readFileSync(new URL("../index.html", import.meta.url), "utf8")].join("\n");

type Rule = Readonly<{ context: string; selectors: readonly string[]; line: number; declarations: ReadonlyMap<string, string> }>;

// Enough of a parser for one hand-written stylesheet: comments out, at-rules
// as a context stack, declarations split on semicolons.
function rules(text: string): Rule[] {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found: Rule[] = [];
  const stack: ({ kind: "context"; head: string } | { kind: "rule"; declarations: Map<string, string> })[] = [];
  let buffer = "";
  let line = 1;
  let start = 1;
  const declare = () => {
    const top = stack.at(-1);
    const text = buffer.trim();
    const colon = text.indexOf(":");
    if (top?.kind === "rule" && colon > 0) top.declarations.set(text.slice(0, colon).trim(), text.slice(colon + 1).trim());
  };
  for (const ch of source) {
    if (ch === "{") {
      const head = buffer.trim();
      if (head.startsWith("@")) stack.push({ kind: "context", head });
      else {
        const declarations = new Map<string, string>();
        const context = stack.filter((entry) => entry.kind === "context").map((entry) => (entry as { head: string }).head).join(" | ");
        found.push({ context, selectors: head.split(",").map((selector) => selector.trim()), line: start, declarations });
        stack.push({ kind: "rule", declarations });
      }
      buffer = "";
    } else if (ch === "}") {
      declare();
      stack.pop();
      buffer = "";
    } else if (ch === ";") {
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

test("every t-* class terminal.css styles is used by the skin", () => {
  const defined = new Set([...css.matchAll(/\.(t-[a-z0-9-]+)/g)].map((match) => match[1] as string));
  // A class built from a template literal (`t-mark-${kind}`) is used by its prefix.
  const prefixes = [...code.matchAll(/(t-[a-z0-9-]+-)\$\{/g)].map((match) => match[1] as string);
  const dead = [...defined].filter((name) => {
    if (prefixes.some((prefix) => name.startsWith(prefix))) return false;
    return !new RegExp(`(?<![a-z0-9-])${name}(?![a-z0-9-])`).test(code);
  });
  assert.deepEqual(dead, [], `styled but never rendered: ${dead.join(", ")}`);
});

test("no selector overwrites its own property later in the same context", () => {
  const seen = new Map<string, Rule[]>();
  for (const rule of rules(css)) {
    if (rule.context.includes("keyframes")) continue;
    for (const selector of rule.selectors) {
      const key = `${rule.context} || ${selector}`;
      seen.set(key, [...(seen.get(key) ?? []), rule]);
    }
  }
  const clashes: string[] = [];
  for (const [key, list] of seen) {
    list.forEach((earlier, index) => {
      for (const later of list.slice(index + 1)) {
        for (const [property, value] of earlier.declarations) {
          if (later.declarations.has(property)) {
            clashes.push(`${key.split(" || ")[1]} ${property}: line ${earlier.line} (${value}) then line ${later.line} (${later.declarations.get(property)})`);
          }
        }
      }
    });
  }
  assert.deepEqual(clashes, [], `consolidate into one base rule:\n${clashes.join("\n")}`);
});
