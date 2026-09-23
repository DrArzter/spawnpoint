// A browser's worth of globals, enough for modules that read the window when
// they load and for hooks that read it once. Imported before anything from
// src, because imports run in order and some of the panel reads `window` at
// module scope.
const noop = () => undefined;
const storage = new Map<string, string>();

const fakeWindow = {
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: "#/worlds", search: "", origin: "http://localhost", pathname: "/" },
  history: { replaceState: noop, pushState: noop },
  innerWidth: 1440,
  innerHeight: 900,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};

(globalThis as Record<string, unknown>).window ??= fakeWindow;
(globalThis as Record<string, unknown>).localStorage ??= fakeWindow.localStorage;
if (!("document" in globalThis)) (globalThis as Record<string, unknown>).document = { documentElement: { dataset: {}, style: {} }, querySelector: () => null };

export {};
