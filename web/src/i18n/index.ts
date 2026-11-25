import { createElement, Fragment, type ReactNode } from "react";

import { en } from "./en";
import type { Catalogue, Message, MessageId, Params, ParamsArg } from "./types";

export type { Catalogue, Message, MessageId, Params, Plural } from "./types";

// One catalogue of the console's words (ADR-0098). English is the source: `en.ts` defines every id, and each other
// locale gives the same ids. A locale is fixed for the life of the page; choosing another reloads, as a skin does.

export const LOCALES = ["en", "ru"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** English ships with the page; another catalogue is fetched once, before the app is drawn in it (`entry.ts`). */
const CATALOGUES: Partial<Record<Locale, Readonly<Record<string, Message>>>> = { en };
const LOADERS: Readonly<Record<Exclude<Locale, "en">, () => Promise<Catalogue>>> = { ru: () => import("./ru").then((module) => module.ru) };
/** The tag `Intl` formats dates and numbers with. */
const INTL_TAGS: Readonly<Record<Locale, string>> = { en: "en-GB", ru: "ru-RU" };
/** Each language by its own name, so a reader finds theirs whatever the console speaks now. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { en: "English", ru: "Русский" };

const STORAGE_KEY = "spawnpoint.locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Which language the console speaks. `?lang=` in the address wins and is remembered, then the remembered choice,
 * then the first of the browser's languages that the catalogue has, then English.
 */
export function chooseLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const requested = new URLSearchParams(window.location.search).get("lang");
    if (isLocale(requested)) {
      window.localStorage.setItem(STORAGE_KEY, requested);
      return requested;
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Storage may be unavailable in a restricted embedded browser; the browser's languages serve.
  }
  for (const tag of window.navigator?.languages ?? []) {
    const primary = tag.toLowerCase().split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

let current: Locale = chooseLocale();

export function currentLocale(): Locale {
  return current;
}

/** The `Intl` tag of the current locale, for dates, numbers and plural rules. */
export function intlLocale(): string {
  return INTL_TAGS[current];
}

/** Fetch the current locale's catalogue; English is already here. A catalogue that does not arrive leaves English. */
export async function loadLocale(): Promise<void> {
  if (CATALOGUES[current]) return;
  try {
    CATALOGUES[current] = await LOADERS[current as Exclude<Locale, "en">]();
  } catch {
    current = DEFAULT_LOCALE;
  }
}

/** Speak another language from now on, with its catalogue. Only tests call this; the app reloads through `speak`. */
export function setLocale(locale: Locale, catalogue?: Catalogue): void {
  if (catalogue) CATALOGUES[locale] = catalogue;
  current = locale;
  plurals = null;
}

/** Choose a language for this browser and reload, so every surface is drawn in it from the start. */
export function speak(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Without storage the choice lasts one visit, which the address carries.
  }
  const url = new URL(window.location.href);
  url.searchParams.set("lang", locale);
  window.location.replace(url.toString());
}

let plurals: Intl.PluralRules | null = null;

function select(message: Message, count: number | undefined): string {
  if (typeof message === "string") return message;
  plurals ??= new Intl.PluralRules(intlLocale());
  return message[plurals.select(count ?? 0)] ?? message.other;
}

function fill(text: string, params: Readonly<Record<string, string | number>> | undefined): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (hole, name: string) => (name in params ? String(params[name]) : hole));
}

/** The text of a message in the current locale, its placeholders filled. */
export function t<K extends MessageId>(id: K, ...params: ParamsArg<K>): string {
  const values = params[0] as Readonly<Record<string, string | number>> | undefined;
  const message = CATALOGUES[current]?.[id as string] ?? (en as Readonly<Record<string, Message>>)[id as string]!;
  return fill(select(message, values?.count as number | undefined), values);
}

/** A message whose placeholders hold nodes (a link, a strong word), for text that wraps markup. */
export function rich<K extends MessageId>(id: K, params: { readonly [P in keyof Params<K>]: ReactNode }): ReactNode {
  const values = params as Readonly<Record<string, ReactNode>>;
  const message = CATALOGUES[current]?.[id as string] ?? (en as Readonly<Record<string, Message>>)[id as string]!;
  const count = typeof values.count === "number" ? values.count : undefined;
  const parts = select(message, count).split(/\{(\w+)\}/);
  return createElement(Fragment, null, ...parts.map((part, index) => (index % 2 === 0 ? part : (values[part] ?? `{${part}}`))));
}
