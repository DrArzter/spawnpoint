# UI audit

Drives the running console in headless Chrome and probes the live DOM, instead of asking a person to look at every
screen at every width. It opens each route at fifteen viewports from 360px to 3840px, both sides of every step in `web/DESIGN.md`, in demo mode so the pages carry
real records (`latency=0`, so the demo answers at once and the probe lands on the page, not the boot card), and reports what the design system can be checked against mechanically:

| Check | What counts as a finding |
|---|---|
| Sideways scroll | `documentElement.scrollWidth` wider than the viewport |
| Escaping elements | a visible box past the viewport edge with no scroll container above it |
| Silent truncation | content wider than its box, `overflow: hidden`, no ellipsis |
| Touch targets | an interactive element under 32px in either direction |
| Contrast | text under 4.5:1 against its effective background (3:1 when large) |
| Type ramp | a size/line-height/weight step that DESIGN.md does not record |
| Shapes | a border radius outside the shape scale |
| Elevation | a shadow on a surface that is not menu, dialog, sheet or snackbar |
| Faces | every font family in use, to hold the Three-Face Rule |
| Text under a control | a text run or another control under a button, link or field it does not belong to |
| Row broke its line | a row that promises one line (`LAYOUT.oneLine`, such as the page header) wrapped |
| Empty state off centre | an empty state more than 4px from the middle of its box |
| Label off its value | a label beside its value (`LAYOUT.pairs`) more than 1px off the baseline of the value's first line |
| Start off the card edge | in one card or panel, a heading, search, table or detail row (`LAYOUT.rails`) whose content starts more than 1px from the others |
| Menu label cut or ragged | in the first row menu, opened: a label past the menu's edge, or labels that do not begin on one edge |

Run it against a dev server or a preview deployment:

```bash
npm run dev                      # in one terminal
npm run audit:ui                 # light theme, writes audit-light.json
npm run audit:ui -- http://localhost:5173 audit-dark.json dark
SKIN=terminal npm run audit:ui       # another face; the console is worn when SKIN is unset
node tools/ui-audit/summarise.mjs light
node tools/ui-audit/summarise.mjs dark
```

Read the output as evidence, not as a verdict. These results are expected and were judged, not overlooked:

- the mobile drawer sits off the left edge while it is closed, so it reads as an escaping element;
- `.visually-hidden` labels are clipped on purpose, so they read as truncation;
- disabled controls fail contrast by design, and WCAG exempts them;
- a 24px row link passes the 24px minimum on a mouse and grows to 44px under a coarse pointer, below the tool's own
  32px line;
- a few line-height steps are inherited by elements whose text is incidental (avatar initials, the status glyph row,
  the terminal status line), where the step is invisible.

Everything else is worth explaining or fixing.

The routes are listed at the top of `audit.mjs`. Add one whenever a screen is added, otherwise it is never measured.

## The breakpoint gate

`scripts/check.sh ui` (CI job *Breakpoint gate*) builds the demo, serves it, and runs the audit with `--gate`: both
skins at both sides of every step (360, 599, 600, 839, 840, 959, 960 and 1440px). It fails on any geometry finding —
sideways scroll, past the viewport, text under a control, a broken line, off centre, off its value, off the card edge,
a cut or ragged menu — that `accepted.txt` does not list. Touch targets and contrast stay in the report above, where a disabled
control is judged by eye.

```bash
npm run audit:ui:gate                                   # against a running dev server
npm run audit:ui:gate -- --accept                       # write what this run found into accepted.txt
```

Fix a finding rather than accept it. A line in `accepted.txt` is a reviewed exception, and a line the gate no longer
finds is reported so the list only shrinks. A primitive that promises a layout (one line, a level pair, a centred
state, a start on the card edge) adds its selector to `LAYOUT` at the top of `audit.mjs`, so every page that uses it is
held to the promise. A new screen adds its route, or the gate never opens it.

What the probe cannot measure, where a control sits and whether the same control looks the same twice, is read by
eye and written down per face under [`web/audits/`](../../audits/); the terminal skin's pass is
[terminal-skin-2026-09-28.md](../../audits/terminal-skin-2026-09-28.md).
