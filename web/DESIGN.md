---
name: Spawnpoint Console
description: A resource console in the C+A grammar, an AWS-console flavour without its brand, on a content grid that uses the full width. ADR-0072.
colors:
  bg: "#F2F3F3"
  surface: "#FFFFFF"
  surface-2: "#F4F5F6"
  surface-3: "#E7EAED"
  line: "#E3E6E9"
  line-2: "#C6CBD1"
  ink: "#0F141A"
  ink-2: "#56626F"
  ink-3: "#6B7684"
  accent: "#5B47D6"
  accent-soft: "#EFECFC"
  accent-text: "#4936BE"
  band: "#161D26"
  ok: "#1D7A35"
  warn: "#8A5A00"
  err: "#C3361B"
  busy: "#1C68C4"
  off: "#56626F"
colors-dark:
  bg: "#0E1319"
  surface: "#161D26"
  surface-2: "#1C2430"
  ink: "#E8ECF0"
  ink-2: "#AEB8C4"
  accent: "#A897FF"
  band: "#0A0F15"
  ok: "#4CC47A"
  warn: "#F0C45A"
typography:
  body:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "15px"
    lineHeight: "1.45"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.87em"
  title:
    fontSize: "28px"
    fontWeight: 800
    letterSpacing: "-0.02em"
  crumb:
    fontSize: "22px"
    fontWeight: 600
  card-title:
    fontSize: "16px"
    fontWeight: 800
rounded:
  card: "12px"
  control: "10px"
  small: "8px"
  dialog: "18px"
  pill: "999px"
spacing:
  gutter: "clamp(16px, 2vw, 40px)"
  gap: "16px"
  gap-phone: "12px"
  card-x: "18px"
  card-y: "16px"
motion:
  d1: "140ms"
  d2: "240ms"
  d3: "420ms"
  d4: "900ms"
  ease: "cubic-bezier(.22, 1, .36, 1)"
  ease-spring: "cubic-bezier(.34, 1.45, .64, 1)"
  travel: "64px"
---

# Design System: Spawnpoint Console

## Overview

The console is a resource console in the **C+A** grammar ([ADR-0072](../docs/adr/0072-draw-the-console-in-the-c-a-grammar.md)).
It has the flavour of the AWS console without its brand: bold card headers with counts, tinted table headers with sort,
key-value sections in equal columns, icon plus coloured text for status, a flashbar for operations and one primary
button per page. It has no AWS logo, orange, font or names. Spawnpoint stays recognisable through its mark, its names
and its game content.

The views live in `web/src/skins/console`. The models are core's
([ADR-0059](../docs/adr/0059-separate-the-console-into-bones-and-skins.md)): a skin changes how a page is drawn, never
what it offers.

The front door (landing, sign-in, join, email action and connect screens) is outside every skin. It keeps the base
sheets in `web/src/styles` (`tokens.css`, `base.css`, `shell.css`, `components.css`, `landing.css`) and the parts in
`web/src/components/ui`. Some of those parts are behaviour that the skins share too: the snackbar queue
(`Snackbar`), which both skins read, and `Timestamp`, `Tooltip` and `useFilter`, which the terminal skin uses.

## Owner rules

Every page keeps these rules. The UI gate (`scripts/check.sh ui`) and the contract tests check the ones that a
machine can check.

| # | Rule | What it means |
|---|---|---|
| R1 | No explanatory copy | A page title, card title or tab label stands alone. Text appears only where a person must decide or recover, and it is one line. A refusal reason is first the tooltip of the refused control. |
| R2 | Nothing packed at one side | In a row, header or card head, identity is at the start edge and status, count or actions are at the end edge. |
| R3 | A state shown once | One status mark per subject per view. The observed time shows only in the top bar. A desired release shows only while it differs from the active one. |
| R4 | Aligned row columns | Rows of one list share column tracks (one `table`, or a grid with `subgrid`). Labels once, in a header row. One end-edge action column, one button style. |
| R5 | Icons on the text centreline | An icon beside text sits in one `inline-flex` group with it, within 1px of the text's centre. |
| R6 | The breadcrumb is the title | One page header. Earlier segments are quiet links; the last segment is the `h1`. No other heading repeats a segment. |
| R7 | No theme control in the top bar | Theme is only in Profile › Appearance. |
| R8 | Full width used | Card grids add columns with width. No content column is capped, except text inputs and dialogs. |
| R9 | Motion with meaning | Only what the motion inventory lists moves. |
| R10 | No flash on a page switch | A page switch never shows an empty frame or a skeleton. Notifications do not move during it. |
| R11 | Cards in one grid row have one height | Every card grid stretches its rows. Card content stays at the top. |
| R12 | AWS flavour without its brand | See the overview. |
| R13 | Light and dark | Every colour is a token in `styles/tokens.css`. |

Decisions on top of the rules: one Refresh per page, in the top bar; the iris accent is the default and a colour picked
in Profile overrides it.

## Colours

All tokens live in `skins/console/styles/tokens.css` with the `--c-` prefix, scoped to `html[data-skin="console"]`.
The dark block is `html[data-skin="console"][data-theme="dark"]`. Component sheets read only tokens; the
`console-css` test refuses a raw colour, time or easing outside `tokens.css`.

| Group | Tokens | Role |
|---|---|---|
| Ground | `--c-bg`, `--c-surface`, `--c-surface-2`, `--c-surface-3`, `--c-surface-pop` | Page, card, table header and hover, track and skeleton, dialog and menu |
| Lines | `--c-line`, `--c-line-2` | Hairlines, control borders |
| Ink | `--c-ink`, `--c-ink-2`, `--c-ink-3` | Text, labels, faint text (at least 4.5:1 on a surface) |
| Accent | `--c-accent`, `--c-accent-ink`, `--c-accent-soft`, `--c-accent-text`, `--c-accent-line` | Primary button, focus ring, tab ink, chart line; text on accent; selected row; links; pressed chip |
| Band | `--c-band`, `--c-band-2`, `--c-band-3`, `--c-band-ink`, `--c-band-ink-2`, `--c-band-focus` | The ink top bar and its controls |
| Status | `--c-ok`, `--c-warn`, `--c-err`, `--c-busy`, `--c-off`, each with `-bg` | Status text and tints |
| Flashbar | `--c-flash-busy`, `--c-flash-ok`, `--c-flash-err`, `--c-flash-ink` | Operation fills, the same in both themes |
| Games | `--c-g-minecraft`, `--c-g-factorio`, `--c-g-zomboid`, `--c-g-other` | Game identity tint, never a status |

- **Accent.** The default accent is iris (`#5B47D6`, dark `#A897FF`). When a person picks a colour in Profile,
  `styles/accent.ts` derives each role with its contrast checked and marks the root `data-accent="chosen"`; the
  accent roles then follow the derived tokens. Reset returns to iris.
- **Status is never the accent.** The accent never means "ok". Status is always an icon and a label, never colour
  alone.

## Typography

Manrope (400–800) for everything read, JetBrains Mono (400, 500) for IDs, addresses, releases and commands, at `.87em`
of its context. `index.html` asks for both fonts before the first paint. Body is 15px/1.45 with tabular numbers.

| Token | Size | Use |
|---|---|---|
| `--c-fs-xs` | 12px | Table header, chip, badge, axis, group label (uppercase, 800) |
| `--c-fs-s` | 13px | Secondary line, key label, pill |
| `--c-fs-m` | 14px | Table cell, small button, menu item |
| `--c-fs-body` | 15px | Body, field |
| `--c-fs-h2` | 16px / 800 | Card title |
| `--c-fs-dialog` | 19px / 800 | Dialog title |
| `--c-fs-crumb` | 22px / 600 | Earlier breadcrumb segments, the title's count |
| `--c-fs-h1` | 28px / 800 | Page title; 24px under 760px |
| `--c-fs-stat` | 26px / 800 | Hero and stat card value; 22px under 760px |

Icon sizes: 20 by default; 18 in a status and a button; 17 in a pill, an address and a copy button; 15–16 in a chip
and dense rows; 28 in an empty state.

## Layout

| Token | Value | Use |
|---|---|---|
| `--c-pad` | `clamp(16px, 2vw, 40px)` | Page gutter |
| `--c-gap` | 16px, 12px under 760px | Grid gap |
| `--c-card-x` / `--c-card-y` | 18px / 16px (14px x under 760px) | Card body inset |
| `--c-bar` / `--c-rail` / `--c-bottom` | 56px / 80px / 60px | Top bar, rail, phone bottom bar |
| `--c-lcol` | `clamp(320px, 21vw, 400px)` | List column of a split page |
| `--c-row` / `--c-row-h` / `--c-gl-row` | 52px / 42px / 60px (compact 40 / 36 / 46) | Table row, table header, shared-track row |
| `--c-ctl` / `--c-ctl-sm` / `--c-field` | 40px / 34px / 42px | Button, small button, field |
| `--c-target` | 44px | Smallest touch target under 760px and on a coarse pointer |

Density (Comfortable or Compact) is set on `html[data-density]` from the table preferences menu. It changes only the
row tokens and the tile height.

### Grid

One `Grid` primitive: `repeat(auto-fit, minmax(min(100%, var(--c-min)), 1fr))`, `align-items: stretch` (R11). Kinds:
`detail` 360px, `chart` 440px, `stat` 200px, `name` 200px, `perm` 220px. Fixed grids keep the column counts the owner
accepted: `home` 1, 2 from 1024px, 3 from 1200px, 4 from 2000px; `metrics` 1, 2 from 900px, 4 from 1900px; `profile`
1, then `3fr 2fr` from 1600px; Releases stacked.

### Breakpoints

| Step | What changes |
|---|---|
| 760px | Phone below: bottom bar instead of the rail, back button instead of the trail, dialogs dock to the bottom, 44px targets |
| 1024px | Split pages show their list column; the scope switcher becomes a segmented group; the search field shows |
| 1200px | The worlds quick look sits beside the table instead of as a sheet |
| 1280px | The breadcrumb shows the game segment |
| 1500px | The top bar shows the "Refreshed" text beside its Refresh button |
| 2000px | The game home grid takes 4 columns |

Two primitives step by their own width, not the window's, because a split page gives them much less than the window
(container queries):

- **Table**: `optional` columns drop under 1040px of table width, `wide` columns under 960px, and under 760px each row
  becomes a record whose cells carry their header as a label. The roles `matrix` stays a table and stands its role
  names on end under 600px.
- **PageHeader**: under 760px of header width the trail becomes the back button and the title may truncate, so the
  header keeps one line with its actions at the end edge. On a phone the actions take a row of their own.

## Elevation and shape

Level 0 is the page (`--c-bg`). Level 1 is a card, the rail and the list column (`--c-surface`, `--c-shadow`). Level 3
is a menu, dialog, palette, flashbar, toast and tooltip (`--c-surface-pop` or `--c-tip`, `--c-shadow-pop`); in dark it
is one surface step lighter with a `--c-line-2` border. Menus and dialogs open in the top layer, so a moving page
cannot carry them.

Radii: card, flashbar and toast 12px; field, tile and radio card 10px; copy button, menu item and tooltip 8px; dialog
and bottom sheet 18px; button, pill, chip and segmented control 999px.

## Motion

Tokens: `--c-d1` 140ms (hover, press, colour), `--c-d2` 240ms (small surfaces), `--c-d3` 420ms (panels, page moves),
`--c-d4` 900ms (drawing), `--c-ease`, `--c-ease-spring`, `--c-travel` 64px (how far a page sheet travels), and the named loops and dwells (`--c-d-tick`,
`--c-loop-bar`, `--c-loop-spin`, `--c-loop-shimmer`, `--c-shake`, `--c-dwell-copy`, `--c-dwell-toast`). Timers in
TypeScript read `ui/motion.ts`, which the `console-css` test holds equal to the tokens.

An element moves only when the movement tells a person something: a state changed, a thing arrived, or where a thing
came from. Under `prefers-reduced-motion: reduce` every transition is instant and only colour and text change.

| # | Element | Trigger | Motion |
|---|---|---|---|
| A1 | Page switch | Navigation to another page | One mechanism for every view change (A1–A3): `runTransition(kind, direction)` in `ui/transition.ts`, one fade-through in `base.css`. The old view leaves in `--c-out` with a quarter-travel shift; the new one starts after `--c-handover` and comes in by `--c-travel` (32px) from the side the move points to. They barely overlap, so text never shows twice; measured per frame: at most 2 frames with both visible. Direction follows the hierarchy (`data-direction`): deeper (a list to an item, Home to a world) forward from the end edge; up or earlier on the rail back from the start edge; the same place in another game only fades. Order between two pages of one depth follows the rail: Home, Worlds, Releases, Access, Profile. The area is clipped to itself. Back and Forward in the browser do not animate |
| A1n | Navigation through a page change | Page change | The rail and the bottom bar hold still: each is its own transition layer above the page area, so the page sheet never covers them; the nav glyphs do not move or fade; only the current item's pill slides from the old item to the new one, under the glyphs (layer order set by z-index on the groups) |
| A1h | Page header | A page or pane switch | The header is its own transition group: it does not travel with the sheet, holds still and cross-fades in `--c-d2`; words both pages share stay steady, only the words that change dissolve. It is 44px on every page from 760px; under it the title row is 44px and the actions, when a page has any, are one 44px row |
| A2 | Pane switch | Navigation inside a split page | As A1 on the pane only, by `--c-travel-pane` (12px); another world only fades; the list column does not move |
| A3 | Tab switch | Tab activation | As A1 on the tab panel only, by `--c-travel-pane`, in the tab bar's order; the header, the world strip and the tab bar keep still; the group eases the height; the tab ink slides; a switch never shortens the page under the reader (the panel keeps the height the scroll needs), and the tab strip glides to a tab out of view |
| A3h | Panel height | A tab's content changes size: data arrives, another tab or world replaces it | The panel box eases from the old height to the new one in `--c-d3` (`Settle`); it clips only while it moves |
| A4 | Card entrance | First view of a page in the session | All cards rise 12px together; no stagger |
| A5 | Chart draw-in | First view of Metrics; a range change | Reveal from the left |
| A6 | Strip and worlds-by-state bar | First view; a count change | Reveal; segments move |
| A7 | Status change | A world's status value changed | Pop and a one-time ring |
| A8 | Number tick | A count changed | Counts to the new value with a small lift |
| A9 | Row arrival | A new row key while the page is open | Fades in with a soft accent background that clears |
| A10–A12 | Flashbar, busy bar, spinner | An operation starts, changes or ends | Item springs in and collapses out; indeterminate bar; spinner |
| A13–A17 | Quick look, dialog, menu and palette, toast, tooltip | Open | Slide or fade at their anchor |
| A18–A21 | Hover and press, toggle, refused-action shake, copy check | Pointer, change, refusal, copy | Colour, a small press, a two-pass shake, a check icon |

Never animated: the top bar, rail and bottom bar; the flashbar and toasts during a page switch (they float above the
transition); content re-rendered by polling or refresh (only A7–A9 react to a real change); unchanged numbers; table
rows on sort or filter; focus rings; skeletons on a page switch; any attention pulse on an idle element.

## Frame

- **Top bar** (ink band): brand, the game as a pill switcher with its own status, search (`/` or Ctrl K), the
  Refreshed time with the one Refresh button, the Demo chip and the account avatar. No theme control.
- **Rail** (760px and up): Home, Worlds, Releases, a divider, Access with its request badge, Profile. On a phone the
  same items are a bottom bar.
- **Page header**: the breadcrumb is the title; status after it; actions at the end edge of the same row.
- **Flashbar**: operations and outcomes, fixed at the end edge; it never pushes the page.
- **Toast**: refusal reasons and short outcomes, bottom centre.

## Primitives

One file per primitive in `skins/console/ui/`, styles in `skins/console/styles/<primitive>.css`, classes
`c-<primitive>[-part]`. Every control that runs an `Action` renders `data-action`, `aria-disabled` while refused (it
stays focusable and shows the hint) and `aria-busy` while busy. Contract tests: `test/console-ui.test.ts`,
`test/console-markers.test.ts`, `test/console-contract.test.ts`.

| Primitive | Use |
|---|---|
| `ActionButton`, `IconButton` | One Action. Variants `primary` (one per page), `default`, `danger` (confirmation footer only), `ghost` (card-head links); sizes `md` 40px and `sm` 34px, 44px under 760px |
| `Overflow`, `Menu`, `MenuButton` | The row and page "more" menu. Always a menu, so a column has one control; danger items in a last group under a rule |
| `Card`, `Grid`, `SplitPage`, `ListColumn` | Surfaces and layout |
| `PageHeader`, `Tabs` | Page structure |
| `Table`, `TrackList`, `DetailList` | Rows on shared tracks; key-value sections in equal columns |
| `Status`, `Indicator`, `Chip`, `Tile`, `Tick` | State: icon and label; icon with the label in the tooltip; facts; status count tiles; ticking counts |
| `Notice`, `Empty`, `Skeleton`, `ProgressBar` | One-line notices; empty and error states; loading at the final geometry; indeterminate work |
| `Settle` | Wraps the tab panel so its height glides when the content changes size (A3h) |
| `Dialog`, `SidePanel`, `Palette`, `Flashbar`, `Toast`, `Tooltip` | Layers |
| `Field`, `TextInput`, `NumberInput`, `ColourInput`, `Select`, `Toggle`, `RadioCards`, `Checkbox`, `Segmented`, `FilterBar`, `Pager`, `Preferences` | Input |
| `Address`, `Copy`, `Person`, `Avatar`, `GameGlyph`, `Ago` | Facts with a fixed form |
| `StatCard`, `TimeSeriesChart`, `Terminal` | Metrics and the world console |

A primitive that promises a layout emits its marker (`data-layout`, `data-rail`, `data-col`, `data-status`,
`data-scope`, `data-layer`); the UI gate reads them (`web/tools/ui-audit/README.md`).

## States

- **Boot**: a centred card with the mark, one title and an indeterminate bar.
- **Loading**: the region's skeleton at its final geometry; the header, tabs and card heads draw at once. A skeleton is
  built from the shell of the thing it stands for, never from a fixed height: `Table` and `TrackList` take `loading`
  and draw placeholder rows with the loaded row's cells, classes, labels and tracks; `Card loading`, `StatSkeleton`,
  `ChartSkeleton` and `ListItemWorldSkeleton` keep a card, a stat, a chart and a world row at their size; a `Skeleton
  text` is exactly one line of its container. A list draws as many placeholder rows as it knows, else as many as it
  showed last time in the session, else three, so another world's backups are as tall loading as loaded.
- **Empty**: one icon, one title, at most one Action.
- **Error**: the empty state's error variant with the reason as one line and Retry. A refused role shows a lock and
  no Retry.

## Skins

A skin is a set of views over the same models; it may not change what a page offers, only how it is drawn
([ADR-0059](../docs/adr/0059-separate-the-console-into-bones-and-skins.md)). Two skins ship: `console`, the default,
described above, and `terminal`. A person picks one in Profile › Appearance › Look, or tries one with `?skin=`.

`index.html` stamps `html[data-skin]` from `spawnpoint.skin` (or `?skin=`, else `console`) before the first paint and
asks for the skin's fonts. `main.tsx` paints the remembered accent and theme before the first render, and `App`
confirms or removes the stamp for the surface it shows (`wearOnDocument`): the front door never wears a skin.

### Terminal

`skins/terminal` draws the console as one monospace screen: a top row, a menu row, then the grid, every row the full
width on a phone as on a 4K monitor. Every view is the face's own, built from its own vocabulary in `ui.tsx` (panel,
verb, mark and state, table, tabs, field, toggle, details, overflow, modal, drawer) and styled only by `terminal.css`
in its own `t-*` classes; the console face's primitives and sheets play no part in it. The rules apply while the
document carries `html[data-skin="terminal"]`, which `index.html` stamps before the first paint and `App` keeps true.

- **One face.** B612 Mono for everything. `index.html` asks for it before the first paint, and the shell makes sure it has loaded. Two weights, 400 and 700, and
  inversion carry emphasis; whatever the console sets to medium is bold here. Lines sit on the 4px grid: 16px under
  12px type (labels, column headings, small print), 20px under 13px and 14px (everything read), 24px under the 18px
  page title, 28px under the 22px host headline. A panel's name sits in its top rule as a tracked uppercase label.
- **No radius, no shadow.** Every corner is square and every surface is flat. Boxes are drawn with `--rule`, one step
  darker than the hairline, so they read as box-drawing lines rather than card borders. Menus are boxed the same way.
  A question and a form open in the same box in the middle of the screen. Over the scrim a name on the rule would
  show its ground above the box, so a box in the top layer keeps its title on its first line, with the close key at
  that line's end for a form; its foot holds the primary verb, then Cancel (Close, for a reading). Nothing docks to
  an edge of the screen.
- **A mark and a word.** Status is a bracketed mark in front of its label, never colour alone: `[*]` ok, `[>]` ready,
  `[-]` off, `[.]` pending, `[?]` unknown, `[!]` error and warning, `[i]` info, `[x]` archived, `[+]` absent. Progress
  is the one mark that moves: `[~]` spinning through `|`, `/`, `-` and `\`, held on the tilde under reduced motion.
  Notices carry the same marks in front of their titles. Dense rows use `Indicator`: the same visible mark with the
  word in its tooltip and accessible label. `State` is reserved for places with room for both mark and word.
- **Bracketed controls.** A button is its label between `[` and `]`, and nothing is filled: the primary verb keeps
  the accent in its word and its brackets where a secondary verb's brackets are dim, the danger verb says so in red,
  and hover is an underline. A verb carries no icon, whatever the model suggests; the only keys that hold a glyph are
  the ones whose word is their label (copy, the overflow, close, the theme), and the spinning mark stands in front of
  the word while a key is busy. Two heights and no other: 36px, and 32px for a key inside a table or beside a state;
  44 and 40 under a finger. A key beside a field is centred on it, never stretched to it. The primary tone marks the
  one verb a screen exists for; the same verb reached from elsewhere is plain. One of several is a radio drawn in
  glyphs, `(o)` for the chosen and `( )` for the rest, in the theme and look pickers, the metrics window and the
  backup filter alike; a radio with small print under it (the invitation audience) is the same mark and word with
  the print beneath, rows parted by a hairline, never a card; a switch is `[x]` or `[ ]`. Tabs are cells on a rule;
  the selected one is inverted, as the menu row's current page is.
- **From the left.** Nothing floats to the far edge of a line. A page head is two lines, what the page is and then
  what can be done to it, the verb that matters first. The verb that matters comes first wherever verbs stand in a
  row: a page head, a panel's rule, a table row, a dialog's foot (`[Stop session] [Cancel]`), the end of a form;
  Cancel is last, and in a question focus rests on it. A named panel's verbs sit in its top rule at the right, as its
  name sits at the left, and step down to a line under the name where the two would meet (under 700px); the rule
  holds keys and nothing else, and a state, a note or a row of choices that belongs to the whole box is the first
  line inside it. A verb row starts at the left wherever it is, in a box's foot, under a form, in a record. The
  right edge is kept by these and only these: a table's verb column, a list row's state and verbs, the retry in a
  notice, the frame's own bar and the menu row's note, the number in a chart's caption, and a dialog's close key at
  the end of its title line. The overflow list hangs from its key's left edge when the key stands in the left half
  of the screen, from its right edge otherwise. A details list gives its labels a column as wide as the longest of
  them and no wider, so a value starts right after its name, and puts the label above the value where the box is
  narrower than 480px. A value and its copy key are one unit that never breaks across lines, in a details list or a
  table cell. Every row of a table is as tall as a small key with its padding, whether or not it holds one. On a
  phone a table is a stack of records, each cell one line with its label as a dim word before the value and the
  verbs on the last line.
- **One primitive, one intent.** `Person` owns avatar/name/detail rows across access requests, identities and people
  pickers. `Address` owns the network glyph, mono address and copy key on one centreline. `Table decision` owns the
  person/control/action composition for both access tables, including its compact grid. `Key`, `IconKey`, `Verb`,
  `Overflow`, `State` and `Indicator` are the only bracketed controls and status treatments; screens do not rebuild
  their glyphs or spacing locally.
- **The host scene.** The first screen draws the scoped game's icon in a glyph ramp (`" .:-=+*#%@"`) on a dark cell,
  40×18 cells, 24×11 on a phone. `HostScene` is the adapter: it takes a painter's grid of brightness per cell, sets the
  exposure from the session state and keeps time. `GameIcon` picks the painter: the Spawnpoint mark is a sampled grid
  (`marks.json`), the Minecraft creeper face is a procedural pixel grid, and both keep still and breathe; the Factorio
  gear and the Zomboid zombie are drawn
  by `raster.ts` from shapes and move through their phase while the host is online, the gear turning, the zombie
  walking across and coming back in. Starting and stopping show the picture at rest under one brighter scanline;
  stopped is sparse and still. Reduced motion stops the tick.
- **Metrics as the status page draws them.** One series is one 120px well with its line in the accent and the area
  under it filled at a tenth of it, no axes and no grid; a caption under the well names the series and its peak, and
  the window is stated once under all of them. A gap in the readings is a gap in the line, never a line to zero.
  A world's metrics span every host its sessions ran on, so an earlier session shows beside the current one and a
  stopped world shows its history. The console skin draws the same data in `TimeSeriesChart` and the Host running
  strip: a missing reading is a hatched "No host" gap, never joined, for CPU and network. Two marks are not gaps. The
  newest slots of a running session that the readings have not reached (EC2 reports minutes late) are a neutral "Not
  reported yet" band, from the server's `pendingFrom`; they stay out of the strip's share. Memory, which a probe
  reads every 15 minutes, is the one series the server joins: readings no more than a probe (plus a margin) apart,
  from one host, with CPU in every slot between, get flagged `interpolated` points. They draw as line, read "(joined)"
  in the tooltip and table, and never count as the latest, the peak or the average.
- **Placeholders.** A loading region is announced once, while shared skeleton primitives preserve the final
  geometry and any labels already known. Terminal plots use quiet, discrete traces rather than fake readings or a
  web shimmer; text uses a small fixed vocabulary of widths. The metrics wells stay at their final 120px height so
  nothing moves when the numbers land. Reduced motion freezes every trace. Simple waits and boot sequences may still
  use one `[~]` line when there is no useful final geometry to show.
- **Spacing.** The page gutter and the gap between panels come from the base tokens (`--gutter`: 24px, 16px on a phone); a named panel
  keeps 10px more above it for the name on its rule, 20px when its verbs sit there too, an unnamed one does not. Cells are 16px in from the rule, 12px at
  the medium step so the worlds table fits a tablet in the wider face. Under a coarse pointer the frame's controls
  (scope, avatar, menu words) are 36px tall inside their 40px rows and a chip is 32px.
- **What it does not do.** It never restyles the front door or sign-in, never introduces a new colour, and never hides
  an action the model offers; the contract test holds it to the same list as the console face.

## Do's and Don'ts

### Do:
- **Do** pair every status with its icon and a label; never colour alone.
- **Do** put identity at the start edge and status, counts and actions at the end edge of every row.
- **Do** draw a list as one table or one shared-track grid, with labels once and one action column.
- **Do** let card grids add columns with width, and stretch the cards of one row to one height.
- **Do** keep the one Refresh in the top bar; a page shows its own refresh only as Retry in an error state.
- **Do** put a refusal reason in the refused control's tooltip first.
- **Do** read every colour, time and easing from `skins/console/styles/tokens.css`.

### Don't:
- **Don't** add a subtitle, helper line or section intro (R1).
- **Don't** say a state twice in one view (R3).
- **Don't** repeat the page title in a heading, card title or tab (R6).
- **Don't** put a theme control in the top bar (R7).
- **Don't** cap the content width; the 4K case is a design target.
- **Don't** animate anything the motion inventory does not list, or move notifications during a page switch.
- **Don't** use AWS names, its logo, its orange or its font.
