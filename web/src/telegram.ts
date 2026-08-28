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

export type Theme = "light" | "dark";
export type ViewerProfile = {
  displayName: string;
  inTelegram: boolean;
  username?: string;
  photoUrl?: string;
  telegramId?: string;
};

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function getPreferredTheme(): Theme {
  const telegramTheme = window.Telegram?.WebApp.colorScheme;
  if (telegramTheme) return telegramTheme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
  const app = window.Telegram?.WebApp;
  if (!app?.initData) return;
  const background = theme === "dark" ? "#111318" : "#f8fafd";
  app.setHeaderColor(theme === "dark" ? "#17191f" : "#ffffff");
  app.setBackgroundColor(background);
}

export function initializeTelegram(onThemeChange: (theme: Theme) => void): () => void {
  const app = window.Telegram?.WebApp;
  if (!app) return () => undefined;
  const isTelegramSession = app.initData.length > 0;
  if (!isTelegramSession) return () => undefined;

  const handleThemeChanged = () => onThemeChange(app.colorScheme);
  app.onEvent("themeChanged", handleThemeChanged);
  app.expand();
  app.ready();
  return () => app.offEvent("themeChanged", handleThemeChanged);
}
