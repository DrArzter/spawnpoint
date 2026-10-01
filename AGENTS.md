# Repository agent instructions

## Web UI: consistency is a contract

Before changing anything under `web/`, read `web/PRODUCT.md` and `web/DESIGN.md`. They describe product truth and the visual systems. A screenshot is evidence, not the component contract.

Consistency does **not** mean that two elements happen to look similar. It means that every occurrence with the same intent is rendered by the same component, variant, token, responsive rule, and accessibility contract. Two hand-built controls that merely share CSS values are inconsistent, even when their screenshots match.

### Required workflow

1. Search for the existing semantic primitive before writing markup or CSS.
   - Shared console primitives live in `web/src/components/ui/`.
   - Terminal primitives live in `web/src/skins/terminal/ui.tsx` and are styled in `web/src/skins/terminal/terminal.css`.
2. If the intent already exists, use its component. Do not reproduce its DOM, brackets, icon, tooltip, padding, status colour, table layout, or breakpoint behavior locally.
3. If the same intent appears at least three times and no primitive fits, add or extend a narrowly named shared component or variant. Do not create a generic abstraction for unrelated elements that only look alike.
4. Migrate every equivalent occurrence in the touched flow. A fix is incomplete when one screen uses the contract and a neighboring screen still carries a lookalike implementation.
5. Delete the superseded markup and CSS exception. Do not leave the old path available for the next screen to copy.
6. Add a contract test when introducing or changing a primitive. Test semantic markup, accessibility labels, stable variant classes, and action reachability; do not snapshot an entire page.

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

`web/test/terminal-css.test.ts` enforces two of these rules on `terminal.css`: every styled `t-*` class has a consumer in `web/src` (a class built as `` `t-mark-${kind}` `` counts by its prefix), and no selector sets the same property twice in one cascade context. When it fails, consolidate the rules or delete the dead class; do not silence it.

### Verification

For changes under `web/`:

1. Run `npm test` and `npm run build` from `web/`.
2. Run `git diff --check`.
3. Inspect the complete affected path once on desktop and mobile. Verify the shared component everywhere it appears, not only on the screenshot that exposed the problem.
4. Check long values, empty/loading/error/disabled states, keyboard focus, tooltips, touch targets, and horizontal overflow as applicable.
5. Before finishing CSS work, check for same-context duplicate selectors, overwritten properties, and dead `t-*` classes.

Do not call a UI change complete because one example looks correct. It is complete when every same-intent occurrence uses the same contract and the old competing implementation is gone.
