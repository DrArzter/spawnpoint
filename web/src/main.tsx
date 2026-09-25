import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyAccent, DEFAULT_ACCENT } from "./styles/accent";
import { getStoredAccent, getThemePreference, resolveTheme } from "./telegram";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/screens.css";
import "./styles/landing.css";
import "./skins/terminal/terminal.css";

// The remembered accent is painted before the first frame, not in an effect
// after it: a colour that arrives a frame late is a flash of the default on
// every load. The identity's copy overrides it once the session answers.
applyAccent(document.documentElement, getStoredAccent() ?? DEFAULT_ACCENT, resolveTheme(getThemePreference()));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
