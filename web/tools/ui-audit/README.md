# UI audit

Drives the running console in headless Chrome and probes the live DOM, instead of asking a person to look at every
screen at every width. It opens each route at fifteen viewports from 360px to 3840px, both sides of every step in `web/DESIGN.md`, in demo mode so the pages carry
real records, and reports what the design system can be checked against mechanically:

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
