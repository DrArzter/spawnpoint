import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// One reader for the hand-written stylesheets that AGENTS.md holds to its CSS
// rules, and the checks every sheet obeys. The console, terminal and
// front-door CSS tests declare their sheets, scope and allow-lists, and
// `cssRuleTests` runs the same rules over each. The scans are written by hand
// on purpose: a regular expression over a whole stylesheet or source tree
// would backtrack.

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

// --- parsing -------------------------------------------------------------------------

// Comments become spaces, so line numbers and offsets stay as they were.
function blankComments(text: string): string {
  let out = "";
  let at = 0;
  for (let open = text.indexOf("/*"); open >= 0; open = text.indexOf("/*", at)) {
    const close = text.indexOf("*/", open + 2);
    const end = close < 0 ? text.length : close + 2;
    out += text.slice(at, open) + text.slice(open, end).replaceAll(/[^\n]/g, " ");
    at = end;
  }
  return out + text.slice(at);
}

// Commas inside :is() or :not() do not separate selectors.
function selectorList(head: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of head) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  return [...parts, current.trim()];
}

type Frame = { kind: "context"; head: string } | { kind: "rule"; declarations: Map<string, string> };

// A reader that walks a sheet once: at-rules are a context stack, a rule opens
// on "{", declarations end at ";" outside parentheses.
class SheetReader {
  readonly found: Rule[] = [];
  private readonly stack: Frame[] = [];
  private buffer = "";
  private line = 1;
  private start = 1;
  private depth = 0;

  constructor(private readonly sheet: string) {}

  read(source: string): Rule[] {
    for (const ch of source) {
      this.step(ch);
      if (ch === "\n") this.line += 1;
    }
    return this.found;
  }

  private step(ch: string) {
    if (ch === "(") this.depth += 1;
    if (ch === ")") this.depth -= 1;
    if (ch === "{") this.open();
    else if (ch === "}") this.close();
    else if (ch === ";" && this.depth === 0) this.declare();
    else this.append(ch);
  }

  private append(ch: string) {
    if (this.buffer.trim() === "" && !/\s/.test(ch)) this.start = this.line;
    this.buffer += ch;
  }

  private declare() {
    const top = this.stack.at(-1);
    const body = this.buffer.trim();
    const colon = body.indexOf(":");
    if (top?.kind === "rule" && colon > 0) top.declarations.set(body.slice(0, colon).trim(), body.slice(colon + 1).trim());
    this.buffer = "";
  }

  private contextHeads(): string {
    return this.stack.flatMap((entry) => (entry.kind === "context" ? [entry.head] : [])).join(" | ");
  }

  private open() {
    const head = this.buffer.trim();
    if (head.startsWith("@")) this.stack.push({ kind: "context", head });
    else {
      const declarations = new Map<string, string>();
      this.found.push({ sheet: this.sheet, context: this.contextHeads(), selectors: selectorList(head), line: this.start, declarations });
      this.stack.push({ kind: "rule", declarations });
    }
    this.buffer = "";
  }

  private close() {
    this.declare();
    this.stack.pop();
  }
}

export function parseRules(sheet: string, text: string): Rule[] {
  return new SheetReader(sheet).read(blankComments(text));
}

/** Every rule of the sheets, keyframe steps left out (a step is not a selector). */
export function rulesOf(sheets: readonly Sheet[]): Rule[] {
  return sheets.flatMap((sheet) => parseRules(sheet.name, sheet.text)).filter((rule) => !rule.context.includes("keyframes"));
}

// --- classes -------------------------------------------------------------------------

const isNameChar = (ch: string | undefined) => ch !== undefined && /[\w-]/.test(ch);

// An attribute value is a string, not a class.
function withoutAttributes(selector: string): string {
  let out = "";
  let inside = false;
  for (const ch of selector) {
    if (ch === "[") inside = true;
    else if (ch === "]") inside = false;
    else if (!inside) out += ch;
  }
  return out;
}

function classNamesIn(selector: string): string[] {
  const text = withoutAttributes(selector);
  const names: string[] = [];
  for (let at = text.indexOf("."); at >= 0; at = text.indexOf(".", at + 1)) {
    let end = at + 1;
    while (isNameChar(text[end])) end += 1;
    const name = text.slice(at + 1, end);
    // "*.move" in ::view-transition-group(*.move) names a transition class set from script, not a rendered one.
    if (name !== "" && !/^\d/.test(name) && text[at - 1] !== "*") names.push(name);
  }
  return names;
}

/** The class names the selectors of these rules style. */
export function classesStyled(rules: readonly Rule[]): Set<string> {
  return new Set(rules.flatMap((rule) => rule.selectors.flatMap(classNamesIn)));
}

// The text of every string and template literal in the source.
function literalsIn(code: string): string {
  const found: string[] = [];
  let at = 0;
  while (at < code.length) {
    const quote = code[at] as string;
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      at += 1;
      continue;
    }
    let end = at + 1;
    while (end < code.length && code[end] !== quote && (quote === "`" || code[end] !== "\n")) end += 1;
    found.push(code.slice(at, end + 1));
    at = end + 1;
  }
  return found.join("\n");
}

// "t-mark-" from `t-mark-${kind}`. A bare namespace such as `c-${x}` does not count.
function templatePrefixes(code: string): string[] {
  const prefixes: string[] = [];
  for (let at = code.indexOf("-${"); at >= 0; at = code.indexOf("-${", at + 1)) {
    let begin = at;
    while (begin > 0 && isNameChar(code[begin - 1])) begin -= 1;
    const prefix = code.slice(begin, at + 1);
    if (prefix.length > 2 && /^[A-Za-z]/.test(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}

function standsAsToken(literals: string, name: string): boolean {
  for (let at = literals.indexOf(name); at >= 0; at = literals.indexOf(name, at + 1)) {
    if (!isNameChar(literals[at - 1]) && !isNameChar(literals[at + name.length])) return true;
  }
  return false;
}

/**
 * Class names that no source renders. A name counts as used when it stands as
 * a whole token inside a string or template literal of `code`, or when a
 * template literal builds it from a prefix (`t-mark-${kind}` uses t-mark-*).
 * A name that also occurs as another string (an id, say) escapes the check.
 */
export function deadClasses(names: Iterable<string>, code: string): string[] {
  const prefixes = templatePrefixes(code);
  const literals = literalsIn(code);
  return [...names].filter((name) => !prefixes.some((prefix) => name.startsWith(prefix)) && !standsAsToken(literals, name));
}

// --- cascade -------------------------------------------------------------------------

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

// Every pair of rules of one selector in one cascade context, earlier first.
function pairsOf(rules: readonly Rule[]): { selector: string; earlier: Rule; later: Rule }[] {
  const pairs: { selector: string; earlier: Rule; later: Rule }[] = [];
  for (const [key, list] of byContextAndSelector(rules)) {
    const selector = key.split(" || ")[1] as string;
    list.forEach((earlier, index) => list.slice(index + 1).forEach((later) => pairs.push({ selector, earlier, later })));
  }
  return pairs;
}

const at = (rule: Rule) => `${rule.sheet}:${rule.line}`;

/** A property that two rules of one selector in one cascade context both set. */
export function overwrittenProperties(rules: readonly Rule[]): string[] {
  return pairsOf(rules).flatMap(({ selector, earlier, later }) =>
    [...earlier.declarations.keys()].filter((property) => later.declarations.has(property)).map((property) => `${selector} ${property}: ${at(earlier)} then ${at(later)}`));
}

// A shorthand and the longhands it resets.
const LONGHANDS: Readonly<Record<string, RegExp>> = {
  margin: /^margin-/,
  padding: /^padding-/,
  border: /^border-(?!radius)/,
  "border-width": /^border-(top|right|bottom|left|block|inline)-([a-z]+-)?width$/,
  "border-style": /^border-(top|right|bottom|left|block|inline)-([a-z]+-)?style$/,
  "border-color": /^border-(top|right|bottom|left|block|inline)-([a-z]+-)?color$/,
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

// The shorthands `one` sets whose longhands `other` sets, in one direction.
function resetsBy(one: Rule, other: Rule, selector: string): string[] {
  return [...one.declarations.keys()].flatMap((property) => {
    const longhands = LONGHANDS[property];
    if (!longhands) return [];
    return [...other.declarations.keys()]
      .filter((longhand) => longhand !== property && longhands.test(longhand))
      .map((longhand) => `${selector} ${property} and ${longhand}: ${at(one)}, ${at(other)}`);
  });
}

/** A shorthand and one of its longhands set by two rules of one selector in one cascade context, in either order. */
export function shorthandClashes(rules: readonly Rule[]): string[] {
  const clashes = pairsOf(rules).flatMap(({ selector, earlier, later }) => [...resetsBy(earlier, later, selector), ...resetsBy(later, earlier, selector)]);
  return [...new Set(clashes)];
}

/** Rules whose selectors do not all start with `scope`. */
export function unscoped(rules: readonly Rule[], scope: string): string[] {
  return rules.flatMap((rule) => rule.selectors.filter((selector) => !selector.startsWith(scope)).map((selector) => `${at(rule)} ${selector}`));
}

// --- hover ---------------------------------------------------------------------------

// What changes a box's size or the space around it. A hover state may change
// colour, shadow, opacity or a transform, never these: a control that grows
// under the pointer shifts the row it sits in.
const BOX_SIZE_PROPERTIES: ReadonlySet<string> = new Set([
  "width", "height", "min-width", "min-height", "max-width", "max-height", "font", "font-size", "line-height",
]);

function setsBoxSize(property: string): boolean {
  if (BOX_SIZE_PROPERTIES.has(property)) return true;
  if (property.startsWith("padding") || property.startsWith("margin")) return true;
  return property.startsWith("border") && property.endsWith("-width");
}

/** Declarations that change a box's size in a rule whose selectors include a hover state. */
export function hoverSizeChanges(rules: readonly Rule[]): string[] {
  return rules
    .filter((rule) => rule.selectors.some((selector) => selector.includes(":hover")))
    .flatMap((rule) => [...rule.declarations.keys()].filter(setsBoxSize).map((property) => `${at(rule)} ${rule.selectors.join(", ")} sets ${property}`));
}

// --- literals ------------------------------------------------------------------------

// "200ms", ".4s", "-1.2s": a number and a time unit, nothing else in the token.
function isTime(token: string): boolean {
  const unsigned = token.startsWith("-") ? token.slice(1) : token;
  const number = unsigned.endsWith("ms") ? unsigned.slice(0, -2) : unsigned.endsWith("s") ? unsigned.slice(0, -1) : "";
  return number !== "" && /^[\d.]+$/.test(number) && Number.isFinite(Number(number));
}

const HEX_COLOUR = /#[0-9a-fA-F]{3,8}\b/;
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?)\(/;

function isRaw(value: string): boolean {
  const time = value.includes("cubic-bezier(") || value.split(/[\s,()*]+/).some(isTime);
  return time || HEX_COLOUR.test(value) || COLOUR_FUNCTION.test(value);
}

/** Declarations that hold a time, an easing or a colour written out instead of read from a token. */
export function rawLiterals(rules: readonly Rule[]): string[] {
  return rules.flatMap((rule) => [...rule.declarations].filter(([, value]) => isRaw(value)).map(([property, value]) => `${at(rule)} ${property}: ${value}`));
}

// --- the checks every sheet obeys ----------------------------------------------------

export type CssRuleOptions = Readonly<{
  /** The sheets' rules, keyframe steps left out. */
  rules: readonly Rule[];
  /** Every source that may render a class of these sheets. */
  code: string;
  /** Every styled class carries this prefix, but for `shared` ones. Omit for sheets whose classes are unprefixed. */
  prefix?: string;
  /** Classes the face restyles but a shared component owns. */
  shared?: ReadonlySet<string>;
  /** Every selector starts with this. Omit for sheets that are not scoped. */
  scope?: string;
  /** Rules that may hold a time, easing or colour literal (the token blocks). Omit to skip the check. */
  mayHoldLiterals?: (rule: Rule) => boolean;
}>;

/** Registers the rules AGENTS.md sets for a sheet, under a name for the sheet. */
export function cssRuleTests(name: string, options: CssRuleOptions): void {
  const { rules, code, prefix, shared = new Set<string>(), scope, mayHoldLiterals } = options;

  test(`${name}: every styled class is used by the source`, () => {
    const dead = deadClasses(classesStyled(rules), code);
    assert.deepEqual(dead, [], `styled but never rendered: ${dead.join(", ")}`);
  });

  if (prefix !== undefined) {
    test(`${name}: every styled class carries the ${prefix} prefix`, () => {
      const bare = [...classesStyled(rules)].filter((cls) => !cls.startsWith(prefix) && !shared.has(cls));
      assert.deepEqual(bare, [], `the dead-class check sees only ${prefix}* names: ${bare.join(", ")}`);
    });
  }

  test(`${name}: no selector sets the same property twice in one cascade context`, () => {
    const clashes = overwrittenProperties(rules);
    assert.deepEqual(clashes, [], `consolidate into one base rule:\n${clashes.join("\n")}`);
  });

  test(`${name}: no selector sets a shorthand and its longhand in one cascade context`, () => {
    const clashes = shorthandClashes(rules);
    assert.deepEqual(clashes, [], `set the property once:\n${clashes.join("\n")}`);
  });

  test(`${name}: a hover state changes no box's size`, () => {
    const grows = hoverSizeChanges(rules);
    assert.deepEqual(grows, [], `a hover rule may change colour, shadow or a transform, not a size (is a selector list split by another rule?):\n${grows.join("\n")}`);
  });

  if (scope !== undefined) {
    test(`${name}: every rule is scoped to the skin`, () => {
      assert.deepEqual(unscoped(rules, scope), []);
    });
  }

  if (mayHoldLiterals !== undefined) {
    test(`${name}: times, easings and colours are tokens`, () => {
      assert.deepEqual(rawLiterals(rules.filter((rule) => !mayHoldLiterals(rule))), []);
    });
  }
}
