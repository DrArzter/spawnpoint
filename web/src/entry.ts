import { loadLocale } from "./i18n";

// The page's first module: the chosen language's words arrive before any module that speaks them is evaluated, so a
// message read at import time is already in that language (ADR-0098). English needs no fetch.
await loadLocale();
await import("./main");
