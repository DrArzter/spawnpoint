# UI gate

The UI gate drives the demo build in headless Chrome and probes the live DOM. It replaces a person who looks at every
page, state and width. It uses raw Chrome DevTools Protocol (`cdp.mjs`) and has no dependency of its own.

| File | Content |
|---|---|
| `audit.mjs` | The runner: routes, widths, states, the menu walker, keys, `accepted.txt`, the report |
| `probe.js` | The probe that runs in the page and returns the findings |
| `states.mjs` | Every dialog, side panel, drawer, tooltip and toast the gate opens, and the skin files that draw them |
| `fixtures/` | One page per miss of the old gate, a clean page and a clean dialog, for `--self-test` |
| `accepted.txt` | Findings accepted with a reason (optional) |

## What it runs

| Input | Values |
|---|---|
| Skins | `cloud` and `terminal` (set `SKIN` for one) |
| Page widths | 360, 599/600, 839/840, 959/960, 1199/1200, 1440 and 2560: both sides of every step in `web/DESIGN.md` |
| Stride | every 40px from 360 to 1680 on each page, light theme, resized without a reload |
| States | every entry in `states.mjs` at 360, 599, 600, 1440 and 2560 |
| Menus | every menu on a page, opened one at a time, at the same five widths |
| Themes | light everywhere; dark at 360 and 1440 |
| Data | the demo, and `?demo&fixture=stress` (80-character names, more rows) at 360, 840 and 1440 |

The runner waits for fonts and finished animations before it probes. It runs 4 tabs in parallel.

## What fails the gate

| Kind | A finding is |
|---|---|
| `wider` | the page is wider than the width the runner set (a phone that grew) |
| `overflowing` | a box past the left or right edge, with no scroll box above it |
| `sideways` | a scroll box that scrolls sideways and is not marked `data-scroll="expected"` |
| `overlaps`, `textOverText` | two atoms on one layer cross: text by its ink, icons, images, and controls and leaf boxes that paint |
| `wrapped` | a row marked `data-layout="one-line"` broke its line (from `data-from` px) |
| `offCentre` | a `data-layout="centred"` box more than 4px off the middle of its box |
| `misaligned` | a `data-layout="pair"` label beside its value more than 1px off its baseline |
| `offRail` | a `data-rail` start more than 1px off the other starts in its `data-layout="rail"` card |
| `menuCut`, `menuClipped`, `menuRagged` | an open menu past the screen, a label cut, or labels that do not start on one edge |
| `packed` | rule 2: a `data-layout="spread"` row whose end group stops short of the end edge |
| `stateTwice` | rule 3: a `data-status` mark said twice in one card, surface, list item or layer |
| `columns`, `repeatedLabel` | rule 4: in `data-layout="rows"`, a column that drifts, two `data-col="actions"` cells in a row, two button styles in the action column, or a label printed in every row |
| `iconOffLine` | rule 5: an icon beside its text more than 1px off the text's centreline |
| `crumbRepeat` | rule 6: more than one h1 beside a `data-layout="crumbs"` trail, or a heading or tab that repeats the title |
| `gridEdge`, `cardHeights` | rule 8: from 1440px a grid row short of the grid's end edge; cards of one grid row of different heights |
| `error` | a state that opened no surface, or a probe that failed |

The rest goes to the advisory report: packed rows anywhere, explanatory copy (rule 1), stretched cards, touch targets,
contrast and text cut with no ellipsis. A reviewer judges these; they do not fail the gate.

**Layers.** An open modal dialog, an open popover, a fixed or sticky bar and a `data-layer` box each paint as one
layer. The probe compares atoms only within one layer, and skips a pair that another layer covers. A modal makes the
page under it inert, so a state measures only its surface. `data-layer="glyph"` marks decoration that is laid over its
control on purpose (a select caret, the tab ink, a count badge); nothing else is exempt, `aria-hidden` marks included.

**Markers.** The cloud primitives say what they promise with `data-layout`, `data-rail`, `data-col`, `data-status`,
`data-scope` and `data-layer`, and `web/test/cloud-markers.test.ts` holds them to it. The terminal skin has no markers;
`LAYOUT` at the top of `audit.mjs` lists its selectors. A new primitive that promises a layout emits the marker.

**States.** A state is a route and steps: `{ action: id }` presses the control for that Action, or opens the menu that
holds it. `web/test/ui-audit-states.test.ts` fails when a skin file draws a `Dialog`, `SidePanel`, `Modal` or `Drawer`
that `SURFACES` in `states.mjs` does not name. A control that a width does not show is skipped at that width; a state
that opens no surface is a finding.

## Run it

```bash
npm run build && npx vite preview --host 127.0.0.1 --port 4173   # in one terminal
node tools/ui-audit/audit.mjs --self-test                       # the fixtures: every miss caught
npm run audit:ui:gate -- http://127.0.0.1:4173                  # the blocking gate
npm run audit:ui -- http://127.0.0.1:4173                       # the gate and the advisory report
SKIN=cloud AUDIT_ROUTES=world AUDIT_WIDTHS=360,1440 AUDIT_STRIDE=0 AUDIT_STATES= npm run audit:ui:gate -- http://127.0.0.1:4173
```

`AUDIT_ROUTES`, `AUDIT_WIDTHS` and `AUDIT_STATES` narrow a run while you fix; `AUDIT_STRIDE=0` drops the stride;
`AUDIT_WORKERS` sets the tabs; `AUDIT_JSON=file` keeps every probe's raw findings. The report is in `web/out/ui-audit`:
`report.md`, `report.json` and a screenshot per page or state with each finding outlined.

`scripts/check.sh ui` builds, runs the self-test, serves the build and runs the gate with `--gate`. CI sets
`UI_BASE` to the pull request's base, so a pull request that changes nothing under `web/` skips it, and `UI_ADVISE=1`, so
the report is kept as the `ui-audit-report` artifact. A push to `main` always runs it.

## Findings

Fix a finding rather than accept it. `--accept` prints the keys of what this run found. A line in `accepted.txt` is a
key and a reason:

```text
terminal world-wipes 680 light sideways div  # the wipes table scrolls at this one width; fixed by …
```

A key is `skin page width theme kind marker`. The marker is built from `data-*` markers and roles, never from a class
path, so a class rename keeps the key. `*` matches any skin, page, width or theme. A line without a reason after ` # `
fails the gate. A line that no longer matches is reported so the list only shrinks.

What the probe cannot measure, where a control sits and whether the same control looks the same twice, is read by eye
and written down per face under [`web/audits/`](../../audits/).
