/**
 * One chosen colour, turned into the accent tokens the console already reads.
 *
 * A person picks a hue, not a contrast ratio. So nothing here trusts the pick
 * directly: every colour that ends up carrying text is walked along its own
 * lightness until it clears WCAG 1.4.3, and the caller is told when that
 * happened so the screen can say so instead of silently disobeying.
 */

export type Theme = "light" | "dark";

export type Rgb = readonly [number, number, number];

/** The surfaces a derived colour has to survive, per theme. Kept in step with tokens.css. */
const GROUND: Record<Theme, { surface: Rgb; canvas: Rgb; snack: Rgb; onPrimaryCandidates: readonly Rgb[]; containerAlpha: number; stateAlpha: number; stateStrongAlpha: number }> = {
  light: { surface: [255, 255, 255], canvas: [241, 241, 241], snack: [32, 33, 36], onPrimaryCandidates: [[255, 255, 255], [32, 33, 36]], containerAlpha: 0.10, stateAlpha: 0.08, stateStrongAlpha: 0.16 },
  dark: { surface: [51, 51, 51], canvas: [34, 34, 34], snack: [245, 245, 245], onPrimaryCandidates: [[34, 34, 34], [255, 255, 255]], containerAlpha: 0.18, stateAlpha: 0.12, stateStrongAlpha: 0.22 },
};

/** Body text and links. The bar the walk has to clear. */
export const TEXT_CONTRAST = 4.5;

export function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((character) => character + character).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

export const toHex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0")).join("")}`;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

const channelLuminance = (channel: number) => {
  const ratio = channel / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function toHsl([r, g, b]: Rgb): readonly [number, number, number] {
  const red = r / 255, green = g / 255, blue = b / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const span = max - min;
  const saturation = lightness > 0.5 ? span / (2 - max - min) : span / (max + min);
  const hue = max === red
    ? ((green - blue) / span + (green < blue ? 6 : 0))
    : max === green ? (blue - red) / span + 2 : (red - green) / span + 4;
  return [hue / 6, saturation, lightness];
}

export function fromHsl([h, s, l]: readonly [number, number, number]): Rgb {
  if (s === 0) { const grey = Math.round(l * 255); return [grey, grey, grey]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (offset: number) => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(channel(1 / 3) * 255), Math.round(channel(0) * 255), Math.round(channel(-1 / 3) * 255)];
}

const shiftLightness = (colour: Rgb, delta: number): Rgb => {
  const [h, s, l] = toHsl(colour);
  return fromHsl([h, s, clamp(l + delta, 0, 1)]);
};

/**
 * Walks a colour's lightness away from its backgrounds until it is readable on
 * every one of them. Hue and saturation are left alone: the chosen colour
 * should still be recognisably the chosen colour once it is legible.
 *
 * Several backgrounds, not one, because a link is painted on the card, on the
 * canvas behind it and inside a tonal chip made of the accent itself. Clearing
 * only the lightest of those is what makes a palette look fine on a card and
 * fail everywhere else.
 */
export function readableOn(colour: Rgb, backgrounds: Rgb | readonly Rgb[], target = TEXT_CONTRAST): { colour: Rgb; adjusted: boolean } {
  const grounds = Array.isArray(backgrounds[0]) ? backgrounds as readonly Rgb[] : [backgrounds as Rgb];
  const worst = (candidate: Rgb) => Math.min(...grounds.map((ground) => contrast(candidate, ground)));
  if (worst(colour) >= target) return { colour, adjusted: false };
  // Away from the lightest ground, which is the one a dark ink has to beat.
  const lightest = grounds.reduce((a, b) => (relativeLuminance(a) >= relativeLuminance(b) ? a : b));
  const away = relativeLuminance(lightest) > 0.5 ? -0.01 : 0.01;
  let candidate = colour;
  for (let step = 0; step < 100; step += 1) {
    candidate = shiftLightness(candidate, away);
    if (worst(candidate) >= target) return { colour: candidate, adjusted: true };
  }
  // The walk ran out of lightness, which only happens against a mid grey. Black
  // or white is then the only honest answer.
  const ends: Rgb[] = [[0, 0, 0], [255, 255, 255]];
  return { colour: ends.reduce((a, b) => (worst(a) >= worst(b) ? a : b)), adjusted: true };
}

const rgba = (colour: Rgb, alpha: number) => `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${alpha})`;

/** What a translucent colour actually looks like once it is painted on its base. */
const over = (colour: Rgb, alpha: number, base: Rgb): Rgb =>
  [0, 1, 2].map((index) => colour[index] * alpha + base[index] * (1 - alpha)) as unknown as Rgb;

/** Mixes towards white, for the light theme's solid container tint. */
const tint = (colour: Rgb, amount: number): Rgb =>
  [0, 1, 2].map((index) => colour[index] + (255 - colour[index]) * amount) as unknown as Rgb;

export type DerivedAccent = {
  /** CSS custom properties, ready to set on an element. */
  tokens: Record<string, string>;
  /** True when the pick could not be used as given and was moved to stay readable. */
  adjusted: boolean;
  /** What a link or a label actually ends up being, so a preview can show it. */
  ink: string;
};

/**
 * The accent tokens for one theme. The names match tokens.css, so applying this
 * is setting variables rather than overriding rules.
 */
export function deriveAccent(accent: string, theme: Theme): DerivedAccent | null {
  const picked = parseHex(accent);
  if (picked === null) return null;
  const ground = GROUND[theme];

  // A filled button carries a label, so the fill is only allowed to stay where
  // some label colour can sit on it.
  let fill = picked;
  let onFill = ground.onPrimaryCandidates[0];
  let fillAdjusted = false;
  for (let step = 0; step < 100; step += 1) {
    const best = [...ground.onPrimaryCandidates].sort((a, b) => contrast(b, fill) - contrast(a, fill))[0];
    if (contrast(best, fill) >= TEXT_CONTRAST) { onFill = best; break; }
    fill = shiftLightness(fill, theme === "dark" ? 0.01 : -0.01);
    fillAdjusted = true;
    onFill = best;
  }

  // The container is a background for text, so it has to exist before the ink
  // that sits on it can be walked.
  const container: Rgb = theme === "dark" ? over(fill, ground.containerAlpha, ground.surface) : tint(picked, 0.90);
  const ink = readableOn(picked, [ground.surface, ground.canvas, container]);
  const snack = readableOn(picked, ground.snack);
  const toward = theme === "dark" ? 0.06 : -0.06;

  return {
    adjusted: fillAdjusted || ink.adjusted,
    ink: toHex(ink.colour),
    tokens: {
      "--primary": toHex(fill),
      "--primary-ink": toHex(ink.colour),
      "--primary-hover": toHex(shiftLightness(fill, toward)),
      "--primary-pressed": toHex(shiftLightness(fill, toward * 2)),
      "--on-primary": toHex(onFill),
      "--primary-container": theme === "dark" ? rgba(fill, ground.containerAlpha) : toHex(container),
      "--on-primary-container": toHex(readableOn(picked, container).colour),
      "--primary-state": rgba(fill, ground.stateAlpha),
      "--primary-state-strong": rgba(fill, ground.stateStrongAlpha),
      // Info reads as primary in the shipped palette; keeping them equal means a
      // notice and a link cannot drift apart.
      "--info": toHex(fill),
      "--info-container": theme === "dark" ? rgba(fill, 0.16) : toHex(tint(picked, 0.90)),
      // The snackbar is the inverted surface, so its action needs its own walk.
      "--snack-action": toHex(snack.colour),
    },
  };
}

/** The shipped accent, and what "no choice made" means. */
export const DEFAULT_ACCENT = "#1a73e8";

export function applyAccent(root: HTMLElement, accent: string, theme: Theme): DerivedAccent | null {
  const derived = deriveAccent(accent, theme);
  if (derived === null) return null;
  for (const [name, value] of Object.entries(derived.tokens)) root.style.setProperty(name, value);
  return derived;
}

export function clearAccent(root: HTMLElement): void {
  for (const name of Object.keys(deriveAccent(DEFAULT_ACCENT, "light")?.tokens ?? {})) root.style.removeProperty(name);
}
