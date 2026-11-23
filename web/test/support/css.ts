import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// One reader for the hand-written stylesheets that AGENTS.md holds to its CSS
// rules. The console, terminal and front-door CSS tests share it, so a rule
// is written once and every sheet obeys it.

export type Sheet = Readonly<{ name: string; text: string }>;

export type Rule = Readonly<{
  sheet: string;
  context: string;
  selectors: readonly string[];
  line: number;
  declarations: ReadonlyMap<string, string>;
}>;

/** The text of every file under `dir` whose name matches `pattern`. */
export function sourceTexts(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceTexts(path, pattern);
    return pattern.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

/** The `.css` files directly in `dir`, except those named in `skip`. */
export function sheetsIn(dir: string, skip: readonly string[] = []): Sheet[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".css") && !skip.includes(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

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

type Frame = { kind: "context"; head: string } | { kind: "rule"; declarations: Map<string, string> };

// Enough of a parser for hand-written sheets: comments out, at-rules as a
// context stack, declarations split on semicolons outside parentheses.
export function parseRules(sheet: string, text: string): Rule[] {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found: Rule[] = [];
  const stack: Frame[] = [];
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
        const context = stack.flatMap((entry) => (entry.kind === "context" ? [entry.head] : [])).join(" | ");
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

/** Every rule of the sheets, keyframe steps left out (a step is not a selector). */
export function rulesOf(sheets: readonly Sheet[]): Rule[] {
  return sheets.flatMap((sheet) => parseRules(sheet.name, sheet.text)).filter((rule) => !rule.context.includes("keyframes"));
}

/** The class names the selectors of these rules style. */
export function classesStyled(rules: readonly Rule[], prefix = ""): Set<string> {
  const names = new Set<string>();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      // Attribute values are strings, not classes.
      for (const match of selector.replace(/\[[^\]]*\]/g, "").matchAll(/\.([A-Za-z_][\w-]*)/g)) {
        if ((match[1] as string).startsWith(prefix)) names.add(match[1] as string);
      }
    }
  }
  return names;
}

/**
 * Class names that no source renders. A name counts as used when it stands as
 * a whole token inside a string or template literal of `code`, or when a
 * template literal builds it from a prefix (`t-mark-${kind}` uses t-mark-*).
 * A name that also occurs as another string (an id, say) escapes the check.
 */
export function deadClasses(names: Iterable<string>, code: string): string[] {
  const prefixes = [...code.matchAll(/([A-Za-z][\w-]*-)\$\{/g)].map((match) => match[1] as string);
  const literals = [...code.matchAll(/"[^"\n]*"|'[^'\n]*'|`[^`]*`|<[a-z][^>]*>/g)].map((match) => match[0]).join("\n");
  return [...names].filter((name) => {
    if (prefixes.some((prefix) => name.startsWith(prefix))) return false;
    return !new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(literals);
  });
}

function byContextAndSelector(rules: readonly Rule[]): Map<string, Rule[]> {
  const seen = new Map<string, Rule[]>();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      const key = `${rule.context} || ${selector}`;
      seen.set(key, [...(seen.get(key) ?? []), rule]);
    }
  }
  return seen;
}

/** A property that two rules of one selector in one cascade context both set. */
export function overwrittenProperties(rules: readonly Rule[]): string[] {
  const clashes: string[] = [];
  for (const [key, list] of byContextAndSelector(rules)) {
    list.forEach((earlier, index) => {
      for (const later of list.slice(index + 1)) {
        for (const property of earlier.declarations.keys()) {
          if (later.declarations.has(property)) clashes.push(`${key.split(" || ")[1]} ${property}: ${earlier.sheet}:${earlier.line} then ${later.sheet}:${later.line}`);
        }
      }
    });
  }
  return clashes;
}

// A shorthand and the longhands it resets.
const LONGHANDS: Readonly<Record<string, RegExp>> = {
  margin: /^margin-/,
  padding: /^padding-/,
  border: /^border-(?!radius)/,
  "border-width": /^border-(top|right|bottom|left|block|inline)(-[a-z]+)*-width$/,
  "border-style": /^border-(top|right|bottom|left|block|inline)(-[a-z]+)*-style$/,
  "border-color": /^border-(top|right|bottom|left|block|inline)(-[a-z]+)*-color$/,
  "border-radius": /^border-(top|bottom|start|end)-(left|right|start|end)-radius$/,
  background: /^background-/,
  font: /^(font-|line-height$)/,
  gap: /^(row|column)-gap$/,
  inset: /^(top|right|bottom|left)$/,
  overflow: /^overflow-[xy]$/,
  transition: /^transition-/,
  animation: /^animation-/,
  flex: /^flex-(grow|shrink|basis)$/,
  "flex-flow": /^flex-(direction|wrap)$/,
  "grid-template": /^grid-template-/,
  outline: /^outline-/,
  "text-decoration": /^text-decoration-/,
  "list-style": /^list-style-/,
  "place-items": /^(align|justify)-items$/,
  "place-content": /^(align|justify)-content$/,
  "place-self": /^(align|justify)-self$/,
};

/** A shorthand and one of its longhands set by two rules of one selector in one cascade context, in either order. */
export function shorthandClashes(rules: readonly Rule[]): string[] {
  const clashes: string[] = [];
  for (const [key, list] of byContextAndSelector(rules)) {
    list.forEach((first, index) => {
      for (const second of list.slice(index + 1)) {
        for (const [one, other] of [[first, second], [second, first]] as const) {
          for (const property of one.declarations.keys()) {
            const longhands = LONGHANDS[property];
            if (!longhands) continue;
            for (const longhand of other.declarations.keys()) {
              if (longhand !== property && longhands.test(longhand)) clashes.push(`${key.split(" || ")[1]} ${property} and ${longhand}: ${one.sheet}:${one.line}, ${other.sheet}:${other.line}`);
            }
          }
        }
      }
    });
  }
  return [...new Set(clashes)];
}

/** Rules whose selectors do not all start with `scope`. */
export function unscoped(rules: readonly Rule[], scope: string): string[] {
  return rules.flatMap((rule) => rule.selectors.filter((selector) => !selector.startsWith(scope)).map((selector) => `${rule.sheet}:${rule.line} ${selector}`));
}

/** Declarations that hold a time, an easing or a colour written out instead of read from a token. */
export function rawLiterals(rules: readonly Rule[]): string[] {
  const literals: string[] = [];
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      const time = /(^|[\s,(*-])\d*\.?\d+m?s\b/.test(value) || value.includes("cubic-bezier(");
      const colour = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value);
      if (time || colour) literals.push(`${rule.sheet}:${rule.line} ${property}: ${value}`);
    }
  }
  return literals;
}
