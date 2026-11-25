import type { en } from "./en";

type En = typeof en;
/** A stable id of one message in the catalogue. */
export type MessageId = keyof En;

/** The forms of a message that depends on a count, selected by `Intl.PluralRules`; `other` is always present. */
export type Plural = Readonly<Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }>;
export type Message = string | Plural;

/** Every id of English, each with a message of the same shape: a locale cannot miss a key. */
export type Catalogue = { readonly [K in MessageId]: En[K] extends string ? string : Plural };

type Holes<S> = S extends `${string}{${infer P}}${infer R}` ? P | Holes<R> : never;
type HolesOf<M> = M extends string ? Holes<M> : Holes<M[keyof M] & string> | "count";
/** The values a message asks for, by placeholder name; a plural message asks for `count`. */
export type Params<K extends MessageId> = { readonly [P in HolesOf<En[K]>]: P extends "count" ? number : string | number };
export type ParamsArg<K extends MessageId> = [HolesOf<En[K]>] extends [never] ? [] : [Params<K>];
