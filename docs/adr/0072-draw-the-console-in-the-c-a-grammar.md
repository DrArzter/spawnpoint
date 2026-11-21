# ADR-0072 — Draw the console in the C+A grammar

- Status: Accepted — implemented in the same change, 2026-11-21
- Date: 2026-11-21
- Milestone: M4
- Extends: [ADR-0059](0059-separate-the-console-into-bones-and-skins.md)

## Context

Since ADR-0059, the console is core models plus skins. The default skin, `console`, used the Google Cloud console
grammar: one column of full-width cards, a drawer and a scope chip. On a wide screen, most of each card stayed empty.
At 2560px, the Metrics tab left about 57% of a 2256px card empty. The world header showed availability, not the
session.

In November 2026 the owner compared three prototypes. The owner chose a hybrid, **C+A**:

- an ink top bar with the game as a pill switcher;
- a slim icon rail;
- a game home of widget cards;
- a dense worlds table with status tiles, a property filter and a quick look;
- resource pages where the breadcrumb is the title;
- the flavour of the AWS console, without its brand.

The owner also set rules for every page:

- no explanatory copy;
- nothing packed at one side of a row;
- each state shown once;
- rows on shared column tracks, with one action column;
- icons on the text centreline;
- the breadcrumb is the title;
- no theme control in the top bar;
- the cards in one grid row have one height;
- the full width used;
- rich motion, with no flash on a page switch;
- light and dark themes.

The team built the new look as a third skin, `cloud`, one page at a time. During that work, `console` kept the old
views. When every page was complete and the UI gate passed, two default looks were not necessary. Two looks are two
sets of views to keep current. Also, the old look did not obey the owner rules.

## Decision

**The `console` skin draws the C+A views.** The `cloud` folder is now `web/src/skins/console`. The `cloud` id is
removed. These items are deleted:

- the old console views;
- their CSS in `web/src/styles`;
- the shared parts that only the old views used, for example `Sparkline`, the old data table and the old tabs.

The models and the skin contract do not change. The terminal skin stays.

**The grammar** is the grammar in `web/DESIGN.md`:

- A content grid adds columns as the width increases (`Grid`, `auto-fit`). The cards in one row have one height.
- The page header: the breadcrumb is the title. The status comes after it. The actions are at the end edge of the
  same row.
- A list is one table or one grid with shared tracks. Labels show once. There is one action column at the end edge.
  A table changes its layout by its own width, so it also fits beside a split panel.
- Split pages: a list column is beside the pane from 1024px. The quick look is beside the worlds table from 1200px.
- Forms open in side panels and dialogs. Menus and dialogs open in the top layer.
- Metrics are stat cards above a grid of time-series charts.
- Each page has one Refresh, in the top bar.
- A motion inventory: an element moves only to show that a state changed, that a thing arrived, or where a thing
  came from. Notifications do not move during a page switch.
- All colours come from tokens. The default accent is iris. A colour that a person picks in Profile overrides it.

**Model fields.** New optional fields (M1–M9) give the new pages their data, for example the session status on the
world page and the observed time in the shell. A new Action comes from a function, not from a field. Thus the terminal
skin did not change for these fields.

**Checks.**

- `web/test/console-css.test.ts` applies the AGENTS.md cascade rules to the skin's sheets. It also checks that each
  rule is scoped to the skin and that colours, times and easings are tokens.
- `web/test/console-ui.test.ts`, `console-markers.test.ts` and `console-contract.test.ts` check the primitives and
  the pages.
- The UI gate (`scripts/check.sh ui`) checks the console and terminal skins.

## Consequences

- `web/PRODUCT.md` now records the C+A direction. The Google Cloud console grammar no longer applies to the default
  skin.
- All skins keep the same status colours. The accent is different: the console uses iris by default, and the terminal
  keeps its own.
- The front door, sign-in, join, email action and connect screens are not part of a skin. They use the base sheets and
  the parts in `web/src/components/ui`.
- A person who used `?skin=cloud` now gets the default skin. It is the same look.
- A new page or primitive must obey `web/DESIGN.md` and the owner rules. It must emit its layout markers. A new
  surface must add its state to the UI gate's state list.
