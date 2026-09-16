import { useCallback, useEffect, useRef, useState } from "react";

import { AppRoute, ensureRoute, pushRoute, readRoute, replaceRoute } from "../routing";
import { applyTheme, getThemePreference, persistThemePreference, resolveTheme, subscribeToSystemTheme, Theme, ThemePreference } from "../telegram";

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

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(getThemePreference);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(getThemePreference()));
  useEffect(() => {
    persistThemePreference(preference);
    setTheme(resolveTheme(preference));
    if (preference === "system") return subscribeToSystemTheme(setTheme);
  }, [preference]);
  useEffect(() => applyTheme(theme), [theme]);
  const cycle = useCallback(() => {
    setPreference((current) => (current === "system" ? (theme === "dark" ? "light" : "dark") : "system"));
  }, [theme]);
  const label = preference === "system" ? `System theme (${theme})` : `${preference === "dark" ? "Dark" : "Light"} theme`;
  return { preference, theme, cycle, label };
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
