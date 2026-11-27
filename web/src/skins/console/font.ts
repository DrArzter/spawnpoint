const FONT_URL = "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap";

// The face's own fonts. index.html asks for them before the first paint when
// the console is the remembered skin; when the feature flags turn another
// remembered skin away (ADR-0107), the shell asks here, and a second ask is a no-op.
export function ensureConsoleFont(): void {
  if (document.querySelector(`link[href="${FONT_URL}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FONT_URL;
  document.head.append(link);
}
