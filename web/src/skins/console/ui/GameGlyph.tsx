import type { GamePresentation } from "../../../model";
import { cx } from "../../../lib/cx";

/*
 * A game's own tint and line glyph, never a logo and never a status. The
 * game's module names both (ADR-0090); this skin owns the pictures. The name
 * always stands beside it, so the glyph is hidden from assistive technology.
 * A glyph this skin does not know shows the first letter of the game's code,
 * and a tint it does not know is the neutral one.
 */

const glyphs: Readonly<Record<string, string>> = {
  cube: "M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Zm0 0v9m0 0 8-4.5M12 12 4 7.5M12 12v9",
  gear: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1",
  grid: "M5 4h14v16H5V4Zm0 5h14M5 15h14M9 4v16",
};

const tints: ReadonlySet<string> = new Set(["teal", "amber", "rose"]);

type GlyphGame = Readonly<{ code: string; presentation: GamePresentation }>;

export function GameGlyph({ game, size = "md", className }: Readonly<{ game: GlyphGame; size?: "sm" | "md" | "lg"; className?: string }>) {
  const { glyph, tint } = game.presentation;
  const path = glyph === null ? undefined : glyphs[glyph];
  return (
    <span aria-hidden="true" className={cx("c-glyph", `c-glyph-${size}`, tint !== null && tints.has(tint) && `c-glyph-tint-${tint}`, className)}>
      {path
        ? <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><path d={path} /></svg>
        : <span className="c-glyph-letter">{game.code.slice(0, 1)}</span>}
    </span>
  );
}
