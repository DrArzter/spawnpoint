/**
 * How the console looks for one person. Kept here rather than in the browser
 * because a phone and a laptop should agree, and because the panel is not the
 * only surface that may want to know.
 */

export type AppearancePreference = {
  theme: "light" | "dark" | "system";
  accent: string;
};

const THEMES = ["light", "dark", "system"] as const;

/** The shipped blue. A stored value equal to this is a choice, not an absence. */
export const DEFAULT_ACCENT = "#1a73e8";

export function defaultAppearance(): AppearancePreference {
  return { theme: "system", accent: DEFAULT_ACCENT };
}

/**
 * Accepts only a full preference. Contrast is not checked here: the panel
 * derives readable tokens from any hue, so the stored value is what the person
 * picked rather than what survived a ratio.
 */
export function validateAppearance(value: unknown): AppearancePreference | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "theme" && key !== "accent")) return null;
  if (!THEMES.includes(input.theme as (typeof THEMES)[number])) return null;
  if (typeof input.accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(input.accent)) return null;
  return { theme: input.theme as AppearancePreference["theme"], accent: input.accent.toLowerCase() };
}
