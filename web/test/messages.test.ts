import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseAst } from "vite";

import { LOCALES, rich, setLocale, t } from "../src/i18n/index.ts";
import { en } from "../src/i18n/en.ts";
import { ru } from "../src/i18n/ru.ts";
import type { Message } from "../src/i18n/types.ts";

// The catalogue contract (ADR-0098): every locale has exactly English's ids, each message keeps English's
// placeholders and the plural forms its language needs, every id is used, and no view or model carries its own words.

const src = fileURLToPath(new URL("../src/", import.meta.url));
const catalogues: Readonly<Record<(typeof LOCALES)[number], Readonly<Record<string, Message>>>> = { en, ru };

function sourceFiles(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Files whose words are data, not copy: the demo stands in for the API, and the catalogue is the words. */
const isCopy = (file: string) => !/^(demo|i18n)\/|^icons\.tsx$/.test(relative(src, file)) && !file.endsWith(".d.ts");
const files = sourceFiles(src).filter(isCopy);

const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
const holesOf = (message: Message) => typeof message === "string" ? holes(message) : [...new Set(Object.values(message).flatMap((form) => holes(form ?? "")).concat("count"))].sort();

test("every locale has exactly the ids of English", () => {
  const ids = Object.keys(en).sort();
  for (const locale of LOCALES) assert.deepEqual(Object.keys(catalogues[locale]).sort(), ids, locale);
});

test("every message keeps the placeholders of its English source", () => {
  for (const locale of LOCALES) {
    const differ = Object.entries(en).filter(([id, source]) => holesOf(catalogues[locale][id]!).join() !== holesOf(source as Message).join());
    assert.deepEqual(differ.map(([id]) => id), [], locale);
  }
});

test("a plural message gives every form its language selects", () => {
  for (const locale of LOCALES) {
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    const short = Object.entries(catalogues[locale]).filter(([, message]) => typeof message !== "string" && categories.some((category) => !(category in message)));
    assert.deepEqual(short.map(([id]) => id), [], locale);
  }
});

test("every id is used outside the catalogue", () => {
  const used = new Set(files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/["'`]([a-z]+\.[A-Za-z0-9_]+)["'`]/g)].map((match) => match[1]!)));
  assert.deepEqual(Object.keys(en).filter((id) => !used.has(id)), []);
});

// Proper names and marks that read the same in every language.
const SAME_IN_EVERY_LOCALE = new Set(["Spawnpoint", "Telegram", "Google", "Discord", "Minecraft", "Factorio", "Steam", "ZeroTier", "CurseForge", "Modrinth", "GitHub", "Haiku", "Sonnet", "Codex", "SHA-256", "Esc", "Ctrl K", "(o)", "&lt;", "&gt;", "rcon&gt;"]);
/** Attributes whose value is a name for code, not words for a person. */
const CODE_ATTRIBUTES = /^(className|key|id|type|href|src|role|viewBox|d|fill|stroke|autoComplete|inputMode|rel|target|method|htmlFor|variant|tone|size|kind|icon|as|lang|dir|align|width|height|xmlns|pattern|accept|value|defaultValue|layout|status|state|mode|side|placement|patternTransform|transform|data-(?!tip).*|on[A-Z].*|aria-(?!label|description|valuetext|roledescription|placeholder).*)$/;
/** Object keys whose string value is shown to a person. */
const TEXT_KEYS = /^(label|hint|title|description|message|text|detail|placeholder|error|header|failure|forbidden|tip|name|explain|since|purpose|group|reason|why|summary|caption|heading|empty\w*|\w+Label|\w+Text)$/;

const looksLikeWords = (text: string) => /[A-Za-z]{2}/.test(text) && !SAME_IN_EVERY_LOCALE.has(text.trim()) && (/\s/.test(text.trim()) || /^[A-Z][a-z]/.test(text.trim()));

type Node = Readonly<Record<string, unknown> & { type: string; start: number; end: number }>;

function literalsWithWords(file: string): string[] {
  const code = readFileSync(file, "utf8");
  const found: string[] = [];
  const where = (node: Node, text: string) => `${relative(src, file)}:${code.slice(0, node.start).split("\n").length} ${text.trim()}`;
  const textOf = (node: Node | undefined): string | null => {
    if (!node) return null;
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral") return (node.quasis as Node[]).map((quasi) => (quasi.value as { cooked: string }).cooked).join(" ");
    if (node.type === "JSXExpressionContainer") return textOf(node.expression as Node);
    return null;
  };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const current = node as Node;
    if (typeof current.type !== "string") return;
    if (current.type === "JSXText") {
      const text = String(current.value).replace(/\s+/g, " ").trim();
      if (/[A-Za-z]{2}/.test(text) && !SAME_IN_EVERY_LOCALE.has(text)) found.push(where(current, text));
    } else if (current.type === "JSXAttribute") {
      const name = (current.name as { name: string | { name: string } }).name;
      const attribute = typeof name === "string" ? name : name.name;
      const text = textOf(current.value as Node | undefined);
      if (!CODE_ATTRIBUTES.test(attribute) && text !== null && looksLikeWords(text)) found.push(where(current, `${attribute}=${text}`));
    } else if (current.type === "Property" && !current.computed) {
      const key = current.key as Node;
      const name = key.type === "Identifier" ? String(key.name) : String(key.value);
      const text = textOf(current.value as Node);
      if (TEXT_KEYS.test(name) && text !== null && looksLikeWords(text)) found.push(where(current, `${name}: ${text}`));
    }
    for (const [key, child] of Object.entries(current)) if (key !== "type") visit(child);
  };
  visit(parseAst(code, { lang: file.endsWith("x") ? "tsx" : "ts" }));
  return found;
}

test("no view or model carries words of its own: they come from the catalogue", () => {
  assert.deepEqual(files.flatMap(literalsWithWords), []);
});

/** Keyboard keys, which code compares by their English names in every locale. */
const KEY_NAMES = new Set(["Home", "End", "Escape", "Enter", "Tab"]);

function textUsedAsData(file: string, messages: ReadonlySet<string>): string[] {
  const code = readFileSync(file, "utf8");
  const found: string[] = [];
  const check = (node: unknown) => {
    const literal = node as Node | undefined;
    if (literal?.type !== "Literal" || typeof literal.value !== "string" || !messages.has(literal.value) || KEY_NAMES.has(literal.value)) return;
    // A lower-case word is also a code (`"email"`, `"none"`); only a capital or a space marks words for a person.
    if (!/^[A-Z]|\s/.test(literal.value)) return;
    found.push(`${relative(src, file)}:${code.slice(0, literal.start).split("\n").length} ${literal.value}`);
  };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const current = node as Node;
    if (typeof current.type !== "string") return;
    if (current.type === "BinaryExpression" && /^[!=]==?$/.test(String(current.operator))) { check(current.left); check(current.right); }
    if (current.type === "SwitchCase") check(current.test);
    if (current.type === "Property" && !current.computed) check(current.key);
    for (const [key, child] of Object.entries(current)) if (key !== "type") visit(child);
  };
  visit(parseAst(code, { lang: file.endsWith("x") ? "tsx" : "ts" }));
  return found;
}

test("no code compares or keys on an English message, which another locale would not match", () => {
  const messages = new Set(Object.values(en).filter((message): message is string => typeof message === "string"));
  assert.deepEqual(files.flatMap((file) => textUsedAsData(file, messages)), []);
});

test("a message fills its placeholders and selects its plural form by locale", () => {
  try {
    setLocale("en");
    assert.equal(t("common.cancel"), en["common.cancel"]);
    setLocale("ru", ru);
    assert.equal(t("common.cancel"), ru["common.cancel"]);
  } finally {
    setLocale("en");
  }
});

test("a rich message places nodes where its placeholders are", () => {
  const node = rich("access.deleteExpected", { expected: "X" }) as { props: { children: unknown[] } };
  assert.deepEqual(node.props.children, ["Delete ", "X", "?"]);
});
