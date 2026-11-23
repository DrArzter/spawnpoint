# Repository agent instructions

## Backend API: functional ownership

Before changing the HTTP API, read `lambdas/src/handlers/api/README.md`.
Keep `access-api.ts` as the Lambda composition entry. Functional modules own
their handlers and `*-routes.ts` declarations; `route-table.ts` composes them.
Use the shared dispatcher for HTTP authentication and declared route authority.
Do not introduce feature-local HTTP authentication gates, cyclic imports, or
imports from feature handlers back into the route table or Lambda entry.
MCP keeps its distinct OAuth audience/scope checks and reuses feature operations.
Run the Lambda tests, typecheck, build, and `git diff --check` after API changes.

## Data formats and names

Use one format per boundary. The words themselves (host, not instance; preset, not profile) are in
[`CONTEXT.md`](CONTEXT.md), with the spellings to avoid; do not repeat them here.

- A host script reports its result as `key=value` lines, one per line, on standard output. Keys are snake_case; a
  value has no newline. Every branch of a script prints the same keys, so one reader parses any outcome.
- JSON on a wire (the HTTP API, MCP, workflow inputs and outputs) uses camelCase keys.
- Stored attributes (DynamoDB items, S3 object metadata, host files) use snake_case. Do not rename an existing stored
  attribute to match a new rule; readers in production depend on it.
- A new storage key shape (a partition or sort key, an S3 prefix) gets one builder function that every reader and
  writer calls. Do not assemble the same key with a template string in a second place.

## Web UI: consistency is a contract

Before changing anything under `web/`, read `web/PRODUCT.md` and `web/DESIGN.md`. They describe product truth and the visual systems. A screenshot is evidence, not the component contract.

Consistency does **not** mean that two elements happen to look similar. It means that every occurrence with the same intent is rendered by the same component, variant, token, responsive rule, and accessibility contract. Two hand-built controls that merely share CSS values are inconsistent, even when their screenshots match.

### Required workflow

1. Search for the existing semantic primitive before writing markup or CSS.
   - Console primitives live in `web/src/skins/console/ui/` (one file each) and are styled in `web/src/skins/console/styles/` (one sheet each, `c-*` classes under `html[data-skin="console"]`).
   - Terminal primitives live in `web/src/skins/terminal/ui.tsx` and are styled in `web/src/skins/terminal/terminal.css`.
   - The front door's parts (sign-in, landing, boot) live in `web/src/components/ui/` and `web/src/styles/`. A skin draws none of its views with them; it may use the shared behaviour there: the snackbar queue (both skins), and `Timestamp`, `Tooltip` and `useFilter` (terminal).
2. If the intent already exists, use its component. Do not reproduce its DOM, brackets, icon, tooltip, padding, status colour, table layout, or breakpoint behavior locally.
3. If the same intent appears at least three times and no primitive fits, add or extend a narrowly named shared component or variant. Do not create a generic abstraction for unrelated elements that only look alike.
4. Migrate every equivalent occurrence in the touched flow. A fix is incomplete when one screen uses the contract and a neighboring screen still carries a lookalike implementation.
5. Delete the superseded markup and CSS exception. Do not leave the old path available for the next screen to copy.
6. Add a contract test when introducing or changing a primitive. Test semantic markup, accessibility labels, stable variant classes, and action reachability; do not snapshot an entire page.

### Console vocabulary

`web/DESIGN.md` lists the console primitives and the owner rules they keep. Use `ActionButton`, `Overflow` (always a menu, so a column has one control), `Table` and `TrackList` (rows on shared tracks, one action column), `Status` and `Indicator`, `DetailList`, `PageHeader` (the breadcrumb is the title), `Card` and `Grid`, `Empty`, `Skeleton`, `Dialog` and `SidePanel` instead of rebuilding them. A console primitive that promises a layout emits its `data-layout` marker.

### Terminal vocabulary

Use these primitives instead of rebuilding them:

- `State`: a status mark plus a visible label where both fit.
- `Indicator`: a dense status mark whose label lives in the tooltip and accessible text. Do not print a second line such as `Verified`, `Ready`, or `Active and desired` beside it in compact rows.
- `Key`, `Verb`, and `IconKey`: the only bracketed button treatments.
- `Overflow`: the row-level action menu. Do not give a secondary action its own line or invent another kebab trigger.
- `Table`: the table and compact-record contract. Use the `decision` variant for person/control/action rows such as Access requests and Identities.
- `Person`: the avatar, name, and optional detail line used in access tables and people pickers.
- `Address`: the network glyph, mono address, and optional copy action on one centreline.
- `SkeletonGroup`, `SkeletonRows`, and `Skeleton`: one announced loading region and geometry-preserving terminal placeholders. Tables and lists use their shared row skeletons; charts use plot skeletons. Do not add screen-specific shimmer or repeat loading copy in every placeholder.
- `Panel`, `Details`, `Tabs`, `Field`, `Choice`, `Toggle`, `Notice`, `Empty`, `Modal`, and `Drawer`: the corresponding surface and interaction contracts.

If a component lacks a needed capability, extend its typed API and implement the behavior once. Do not bypass it with screen-specific structure.

### Information density and copy

- Keep explanations only when they are unique, actionable, and necessary to make a decision or recover from a state.
- Put short definitions and secondary status wording in tooltips with accessible text.
- Do not add paragraphs that restate a label, table columns, obvious behavior, or information available on the detail screen.
- Prefer a compact indicator or overflow action over dedicating a row to one status or secondary button.

### CSS cascade discipline

- Search for a class before adding or redefining it.
- A selector should have one base definition. Add later rules only for a named state, component variant, media query, or container query.
- Do not rely on a later declaration in the same cascade context to cancel an earlier one. Consolidate the rule instead.
- Keep responsive behavior with the primitive or variant that owns it. Do not create one-screen breakpoint exceptions for a shared pattern.
- Repeated selectors across explicit state/breakpoint contexts are expected. Repeated selectors in the same context require review and a comment if the override is genuinely intentional.
- Remove unused selectors when their component is removed. Do not retain speculative utility classes.
- Use existing tokens and `t-*` scoping. Do not introduce raw colours, spacing values, or unscoped terminal rules when a semantic token already exists.

`web/test/terminal-css.test.ts` enforces two of these rules on `terminal.css`: every styled `t-*` class has a consumer in `web/src` (a class built as `` `t-mark-${kind}` `` counts by its prefix), and no selector sets the same property twice in one cascade context. `web/test/console-css.test.ts` enforces the same two rules on the console sheets for `c-*` classes, and also that every rule is scoped to `html[data-skin="console"]` and that colours, times and easings live only in `tokens.css`. When either fails, consolidate the rules or delete the dead class; do not silence it.

### Verification

For changes under `web/`:

1. Run `npm test` and `npm run build` from `web/`.
2. Run `scripts/check.sh ui`, the UI gate: the console and terminal skins at both sides of every step and on a 40px
   stride, every dialog, panel and menu opened, both themes and the stress fixture. It fails on a page wider than the
   screen, overlapping text, icons or controls, a broken layout promise, or a broken owner rule
   (`web/tools/ui-audit/README.md`). A console primitive that promises a layout emits its `data-layout` marker; a new
   surface adds its state to `web/tools/ui-audit/states.mjs`. `UI_PORT` serves the gate on another port.
3. Run `git diff --check`.
4. Inspect the complete affected path once on desktop and mobile. Verify the shared component everywhere it appears, not only on the screenshot that exposed the problem.
5. Check long values, empty/loading/error/disabled states, keyboard focus, tooltips, touch targets, and horizontal overflow as applicable.
6. Before finishing CSS work, check for same-context duplicate selectors, overwritten properties, and dead `t-*` and `c-*` classes.

Do not call a UI change complete because one example looks correct. It is complete when every same-intent occurrence uses the same contract and the old competing implementation is gone.
