const FONT_URL = "https://fonts.googleapis.com/css2?family=B612+Mono:wght@400;700&display=swap";

// The face's own font. index.html asks for it before the first paint when
// the terminal is the remembered skin; a surface that draws in it asks again
// in case it was not, and the second ask is a no-op.
export function ensureTerminalFont(): void {
  if (document.querySelector(`link[href="${FONT_URL}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FONT_URL;
  document.head.append(link);
}
