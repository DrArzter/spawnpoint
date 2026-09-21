type ThemeParams = Partial<{
  bg_color: string;
  text_color: string;
  hint_color: string;
  link_color: string;
  button_color: string;
  button_text_color: string;
  secondary_bg_color: string;
  header_bg_color: string;
  bottom_bar_bg_color: string;
  accent_text_color: string;
  section_bg_color: string;
  section_header_text_color: string;
  subtitle_text_color: string;
  destructive_text_color: string;
}>;

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: {
    user?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
      photo_url?: string;
    };
  };
  colorScheme: "light" | "dark";
  themeParams: ThemeParams;
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openLink(url: string): void;
  onEvent(event: "themeChanged", callback: () => void): void;
  offEvent(event: "themeChanged", callback: () => void): void;
};

export type TelegramLoginResult = Readonly<{
  id_token?: string;
  error?: string;
}>;

type TelegramLogin = {
  init(options: { client_id: number; request_access?: string[] }, callback: (result: TelegramLoginResult) => void): void;
  open(callback?: (result: TelegramLoginResult) => void): void;
};

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
export type ViewerProfile = {
  displayName: string;
  inTelegram: boolean;
  /** Which account the session was signed in through. */
  provider?: "telegram" | "password";
  username?: string;
  email?: string;
  photoUrl?: string;
  telegramId?: string;
};

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp; Login?: TelegramLogin };
  }
}

const THEME_STORAGE_KEY = "spawnpoint.theme";
const ACCENT_STORAGE_KEY = "spawnpoint.accent";

function systemTheme(): Theme {
  const app = window.Telegram?.WebApp;
  if (app?.initData && app.colorScheme) return app.colorScheme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Storage may be unavailable in a restricted embedded browser.
  }
  return "system";
}

export function resolveTheme(preference: ThemePreference): Theme {
  return preference === "system" ? systemTheme() : preference;
}

export function persistThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The active theme still works for this session when storage is blocked.
  }
}

/**
 * The accent is stored against the identity, but it is also kept here: the
 * panel paints before the session answers, and a colour that arrives a second
 * late is a flash of the wrong palette on every load.
 */
export function getStoredAccent(): string | null {
  try {
    const stored = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    return stored !== null && /^#[0-9a-f]{6}$/i.test(stored) ? stored.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function persistAccent(accent: string): void {
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    // The chosen colour still applies for this session when storage is blocked.
  }
}

export function subscribeToSystemTheme(onChange: (theme: Theme) => void): () => void {
  const app = window.Telegram?.WebApp;
  if (app?.initData) {
    const handleThemeChanged = () => onChange(app.colorScheme);
    app.onEvent("themeChanged", handleThemeChanged);
    return () => app.offEvent("themeChanged", handleThemeChanged);
  }

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handleMediaChanged = (event: MediaQueryListEvent) => onChange(event.matches ? "dark" : "light");
  media.addEventListener("change", handleMediaChanged);
  return () => media.removeEventListener("change", handleMediaChanged);
}

export function getViewerProfile(): ViewerProfile {
  const user = window.Telegram?.WebApp.initDataUnsafe?.user;
  if (!user) return { displayName: "DrArzter", inTelegram: false };
  return {
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" "),
    inTelegram: true,
    username: user.username,
    photoUrl: user.photo_url,
    telegramId: String(user.id),
  };
}

export function openInBrowser(): void {
  const url = `${window.location.origin}${window.location.pathname}`;
  const app = window.Telegram?.WebApp;
  if (app?.initData) app.openLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  // The app bar colour, so the Telegram chrome continues the bar.
  const bar = theme === "dark" ? "#222222" : "#ffffff";
  const canvas = theme === "dark" ? "#222222" : "#f1f1f1";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bar);
  const app = window.Telegram?.WebApp;
  if (!app?.initData) return;
  app.setHeaderColor(bar);
  app.setBackgroundColor(canvas);
}

export function initializeTelegram(): void {
  const app = window.Telegram?.WebApp;
  if (!app) return;
  const isTelegramSession = app.initData.length > 0;
  if (!isTelegramSession) return;
  app.expand();
  app.ready();
}
