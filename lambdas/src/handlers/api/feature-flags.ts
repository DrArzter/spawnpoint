// Feature flags the owner changes without a release (ADR-0107). They live in
// one SSM parameter as JSON, for example {"off": ["worldLog"], "skins": ["console"]}:
// `off` names capabilities to switch off, `skins` the panel skins allowed.
// Every failure fails open: all capabilities on, no skin list.

import { parseJsonText } from "./http.ts";

export type FeatureFlagValues = Readonly<{
  /** Capability names switched off; names the API does not know are left out. */
  off: ReadonlySet<string>;
  /** The skins the panel may wear, or null when the flags do not say. */
  skins: readonly string[] | null;
}>;

/** The port: the flags as they stand, read from wherever the deployment keeps them. */
export type FeatureFlags = Readonly<{ read: () => Promise<FeatureFlagValues> }>;

export const NO_FLAGS: FeatureFlagValues = Object.freeze({ off: new Set<string>(), skins: null });

/** Every capability on and no skin list: the flags of a deployment that has none. */
export const ALL_ON: FeatureFlags = { read: async () => NO_FLAGS };

export type FlagLog = Readonly<{ warn: (message: string) => void; error: (message: string, cause?: unknown) => void }>;

const KEYS = new Set(["off", "skins"]);

function names(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "") ? value.map((item: string) => item.trim()) : null;
}

/**
 * The stored text as flags, or null when it is not flags at all: not JSON, not
 * an object, or a list that is not a list of names. A name or key the API does
 * not know is left out with one warning, so a typo never takes the panel down.
 */
export function parseFeatureFlags(text: string, capabilities: readonly string[], log: FlagLog = console): FeatureFlagValues | null {
  let value: unknown;
  try {
    value = parseJsonText(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const off = record.off === undefined ? [] : names(record.off);
  const skins = record.skins === undefined ? null : names(record.skins);
  if (off === null || (record.skins !== undefined && skins === null)) return null;
  const unknown = [
    ...Object.keys(record).filter((key) => !KEYS.has(key)).map((key) => `key ${key}`),
    ...off.filter((name) => !capabilities.includes(name)).map((name) => `capability ${name}`),
  ];
  if (unknown.length > 0) log.warn(`feature flags: ignored what the API does not know: ${unknown.join(", ")}`);
  return { off: new Set(off.filter((name) => capabilities.includes(name))), skins };
}

export type CacheOptions = Readonly<{
  /** The capability names the API knows. */
  capabilities: readonly string[];
  /** How long one read serves; a change reaches a container within this. */
  ttlMs?: number;
  now?: () => number;
  log?: FlagLog;
}>;

export const FLAGS_TTL_MS = 60_000;

/**
 * Flags read through `fetchText` at most once per `ttlMs` in a container. A
 * value that is not flags, or a read that fails, keeps the last good value;
 * before the first good one, everything is on.
 */
export function cachedFeatureFlags(fetchText: () => Promise<string>, options: CacheOptions): FeatureFlags {
  const { capabilities, ttlMs = FLAGS_TTL_MS, now = Date.now, log = console } = options;
  let last: FeatureFlagValues | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<FeatureFlagValues> | null = null;
  const refresh = async (): Promise<FeatureFlagValues> => {
    try {
      const parsed = parseFeatureFlags(await fetchText(), capabilities, log);
      if (parsed === null) log.error(`feature flags: the parameter is not valid flags JSON; ${last === null ? "everything stays on" : "the last good value stays"}`);
      else last = parsed;
    } catch (error) {
      log.error(`feature flags: the parameter could not be read; ${last === null ? "everything stays on" : "the last good value stays"}`, error);
    } finally {
      readAt = now();
      pending = null;
    }
    return last ?? NO_FLAGS;
  };
  return {
    read: () => {
      if (now() - readAt < ttlMs) return Promise.resolve(last ?? NO_FLAGS);
      pending ??= refresh();
      return pending;
    },
  };
}
