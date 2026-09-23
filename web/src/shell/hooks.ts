import { useCallback, useEffect, useRef, useState } from "react";

import { AppRoute, ensureRoute, pushRoute, readRoute, replaceRoute } from "../routing";
import { applyAccent, DEFAULT_ACCENT } from "../styles/accent";
import { applyTheme, getStoredAccent, getThemePreference, persistAccent, persistThemePreference, resolveTheme, subscribeToSystemTheme, Theme, ThemePreference } from "../telegram";

export function useRoute(): [AppRoute, (patch: Partial<AppRoute>, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    ensureRoute();
    const onChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((patch: Partial<AppRoute>, options?: { replace?: boolean }) => {
    const next: AppRoute = { ...readRoute(), ...patch };
    if (options?.replace) {
      replaceRoute(next);
      setRoute(next);
    } else {
      pushRoute(next);
    }
  }, []);
  return [route, navigate];
}

/**
 * Theme and accent together, because the accent has to be re-derived whenever
 * the theme changes: the same hue needs different lightness to stay readable on
 * white and on #333. Local storage paints immediately; the identity's stored
 * choice overrides it through `adopt` once the session answers.
 */
function afterOneTap(now: ThemePreference, showing: Theme): ThemePreference {
  if (now !== "system") return "system";
  return showing === "dark" ? "light" : "dark";
}

/** What the control plane is told when the person changes something. */
export type AppearanceSync = (next: { theme: ThemePreference; accent: string }) => Promise<unknown>;

/**
 * Theme and accent, painted at once and remembered twice: in this browser, so
 * the panel has its colours before the session answers, and against the
 * identity through `sync`, so the same choice meets the person on the next
 * device. Every setter here writes through — the app bar's toggle used to
 * change the theme locally and leave the account on the old one, which is a
 * choice that quietly fails to follow you.
 *
 * `sync` is absent where nobody is signed in (the front door) and on `adopt`,
 * which is the account speaking, not the person.
 */
export function useAppearance({ sync }: { sync?: AppearanceSync } = {}) {
  const [preference, setPreference] = useState<ThemePreference>(getThemePreference);
  const [accent, setAccentState] = useState<string>(() => getStoredAccent() ?? DEFAULT_ACCENT);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(getThemePreference()));
  // The latest values, readable inside stable callbacks: the account wants the
  // whole preference on every write, not the half that changed.
  const current = useRef({ preference, accent, sync });
  current.current = { preference, accent, sync };

  const push = useCallback((next: { theme: ThemePreference; accent: string }): Promise<void> => {
    const send = current.current.sync;
    return send === undefined ? Promise.resolve() : Promise.resolve(send(next)).then(() => undefined);
  }, []);

  const choosePreference = useCallback((next: ThemePreference): Promise<void> => {
    setPreference(next);
    return push({ theme: next, accent: current.current.accent });
  }, [push]);

  useEffect(() => {
    persistThemePreference(preference);
    setTheme(resolveTheme(preference));
    if (preference === "system") return subscribeToSystemTheme(setTheme);
  }, [preference]);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => { applyAccent(document.documentElement, accent, theme); }, [accent, theme]);

  const setAccent = useCallback((next: string): Promise<void> => {
    persistAccent(next);
    setAccentState(next);
    return push({ theme: current.current.preference, accent: next });
  }, [push]);

  /** What the control plane holds, which outranks whatever this browser cached. */
  const adopt = useCallback((remote: { theme: ThemePreference; accent: string }) => {
    setPreference(remote.theme);
    persistAccent(remote.accent);
    setAccentState(remote.accent);
  }, []);

  // The bar's one-tap toggle. Its write to the account fails quietly: a palette
  // that did not travel is not worth a banner over the page somebody is using.
  const cycle = useCallback(() => {
    void choosePreference(afterOneTap(current.current.preference, theme)).catch(() => undefined);
  }, [theme, choosePreference]);

  const label = preference === "system" ? `System theme (${theme})` : `${preference === "dark" ? "Dark" : "Light"} theme`;
  return { preference, setPreference: choosePreference, theme, accent, setAccent, adopt, cycle, label };
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function useStoredState<T extends string>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (window.localStorage.getItem(key) as T | null) ?? initial;
    } catch {
      return initial;
    }
  });
  const update = useCallback((next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Storage may be unavailable in a restricted embedded browser.
    }
  }, [key]);
  return [value, update];
}

// Two guards on a loading card, from opposite sides. It waits before appearing,
// so an answer that arrives in a blink shows nothing at all; once it has
// appeared it stays long enough to be read, so it never flickers past. A card
// that continues one already on screen skips the wait and only keeps the floor.
export const BOOT_DELAY_MS = 200;
export const BOOT_MINIMUM_MS = 450;

export function useBootCard(continues = false): { visible: boolean; publish: (settle: () => void) => void } {
  const [visible, setVisible] = useState(continues);
  const shownAt = useRef<number | null>(continues ? Date.now() : null);
  const timer = useRef<number | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    if (!continues) {
      timer.current = window.setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, BOOT_DELAY_MS);
    }
    return () => {
      live.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [continues]);

  const publish = useCallback((settle: () => void) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const since = shownAt.current;
    const remaining = since === null ? 0 : Math.max(0, BOOT_MINIMUM_MS - (Date.now() - since));
    if (remaining === 0) settle();
    else window.setTimeout(() => { if (live.current) settle(); }, remaining);
  }, []);

  return { visible, publish };
}
