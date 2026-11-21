# ADR-0072 — Draw the console in the C+A grammar

- Status: Accepted — implemented in the same change, 2026-11-21
- Date: 2026-11-21
- Milestone: M4
- Extends: [ADR-0059](0059-separate-the-console-into-bones-and-skins.md)

## Context

Since ADR-0059 the console is core models plus skins. The default skin, `console`, drew the panel in the Google Cloud
console grammar: one column of full-width cards, a drawer and a scope chip. On a wide screen it left most of each card
empty (the Metrics tab left about 57% of a 2256px card empty at 2560px), and the world header showed availability, not
the session.

The owner compared three prototypes in November 2026 and chose a hybrid, **C+A**: an ink top bar with the game as a
pill switcher, a slim icon rail, a game home of widget cards, a dense worlds table with status tiles, a property filter
and a quick look, resource pages whose breadcrumb is the title, and the flavour of the AWS console without its brand.
The owner also set rules that bind every page: no explanatory copy; nothing packed at one side of a row; a state shown
once; rows on shared column tracks with one action column; icons on the text centreline; the breadcrumb is the title;
no theme control in the top bar; cards in one grid row share one height; the full width used; rich motion without a
flash on a page switch; light and dark.

The new look was built as a third skin, `cloud`, page by page, while `console` kept the old views. When every page was
built and the UI gate passed on it, the two could not both stay: two default looks are two sets of views to keep
current, and the old one no longer matched the owner's rules.

## Decision

**The `console` skin draws the C+A views.** The `cloud` skin folder became `web/src/skins/console`, and the `cloud` id
is gone. The old console views, their CSS in `web/src/styles` and the shared parts that only they used (`Sparkline`,
the old data table, tabs, ellipsis, the app bar and others in `web/src/components/ui`) are deleted. The models and the
skin contract do not change; the terminal skin stays.

**The grammar** is the one `web/DESIGN.md` records:

- A content grid that adds columns with width (`Grid`, `auto-fit`), with cards in one row stretched to one height.
- A page header whose breadcrumb is the title, with status after it and the actions at the end edge of the same row.
- Lists as one table or one shared-track grid, with labels once and one end-edge action column. A table changes
  layout by its own width, so it also fits beside a split panel.
- Split pages: a list column beside the pane from 1024px, and a quick look beside the worlds table from 1200px.
- Side panels and dialogs for forms; menus and dialogs in the top layer.
- Metrics as stat cards over a grid of time-series charts.
- One Refresh per page, in the top bar.
- A motion inventory: an element moves only when the movement says that a state changed, a thing arrived, or where it
  came from. Notifications do not move during a page switch.
- Colour from tokens only. The iris accent is the default, and a colour picked in Profile overrides it.

**Additive model fields** (M1–M9 in the skin specification) carry what the new pages need, such as the session status
on the world page and the shell's observed time. Each is optional, and new Actions are asked for through functions,
so the terminal skin needed no change for them.

**Checks.** `web/test/console-css.test.ts` holds the skin's sheets to the AGENTS.md cascade rules and to its token and
scope rules. `web/test/console-ui.test.ts`, `console-markers.test.ts` and `console-contract.test.ts` hold the
primitives and pages. The UI gate (`scripts/check.sh ui`) runs the console and terminal skins.

## Consequences

- The Google Cloud console grammar in `web/PRODUCT.md` (2026-09-12) no longer describes the default skin. The product
  text must follow.
- The PRODUCT.md note of 2026-09-23 that every skin keeps one palette now holds only for status colours: the console's
  accent is iris by default, the terminal keeps its own.
- The front door, sign-in, join, email action and connect screens are still outside every skin. They keep the base
  sheets and the remaining shared parts in `web/src/components/ui`.
- A person who tried the new look with `?skin=cloud` lands on the default, which is now the same look.
- A new page or primitive follows `web/DESIGN.md` and the owner rules, emits its layout markers, and adds its surfaces
  to the UI gate's state list.
