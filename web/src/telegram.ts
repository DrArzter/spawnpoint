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
  colorScheme: "light" | "dark";
  themeParams: ThemeParams;
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
};

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function initializeTelegram(): boolean {
  const app = window.Telegram?.WebApp;
  if (!app) return false;
  const isTelegramSession = app.initData.length > 0;
  if (!isTelegramSession) return false;

  const root = document.documentElement;
  const theme = app.themeParams;
  const variables: Record<string, string | undefined> = {
    "--tg-bg": theme.bg_color,
    "--tg-text": theme.text_color,
    "--tg-hint": theme.hint_color,
    "--tg-accent": theme.button_color ?? theme.link_color,
    "--tg-accent-text": theme.button_text_color,
    "--tg-surface": theme.secondary_bg_color ?? theme.section_bg_color,
    "--tg-danger": theme.destructive_text_color,
  };
  for (const [name, value] of Object.entries(variables)) {
    if (value) root.style.setProperty(name, value);
  }

  app.setHeaderColor(theme.header_bg_color ?? theme.bg_color ?? "#0b0d10");
  app.setBackgroundColor(theme.bg_color ?? "#0b0d10");
  app.expand();
  app.ready();
  return true;
}
