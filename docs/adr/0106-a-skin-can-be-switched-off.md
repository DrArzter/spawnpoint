# ADR-0106 — A skin can be switched off, and the terminal skin is off

- Status: Accepted
- Date: 2026-11-27
- Milestone: M6
- Amends: [ADR-0059](0059-separate-the-console-into-bones-and-skins.md) — which skins a build wears and tests
- Amended by: [ADR-0107](0107-feature-flags-in-parameter-store.md) — the feature flags may narrow the skins at run time

## Context

ADR-0059 split the panel into bones and skins, and two skins ship: `console`, the default, and `terminal`. The owner
no longer wants the terminal skin offered. Its code still works and may come back, so deleting it would throw away
work that passes its contract today.

Every skin also costs upkeep. The contract tests, the CSS tests and the UI gate run every check once per skin, and a
change to a shared model or primitive must be carried into every skin's views. A skin that nobody wears still costs
all of that.

## Decision

**One list says which skins are switched on: `ENABLED_SKIN_IDS` in `web/src/skins/skin.ts`.** It is `["console"]`
now, so the terminal skin is off.

- **A skin that is off is never worn.** `currentSkinId` ignores a stored `spawnpoint.skin` or a `?skin=` that names a
  skin that is off, uses `DEFAULT_SKIN`, and does not store the value. `index.html` stamps `html[data-skin]` only
  with a skin that is on; the build writes the list into it. A person who chose the terminal before sees the console,
  with no error.
- **A skin that is off is never offered.** `CHOOSABLE_SKIN_IDS` is the enabled list. With one skin on, the profile
  model has no look (`ProfileModel.look` is `null`), so no skin draws the chooser.
- **The default skin is always on.** `enabledSkins` refuses a list without it or with a name it does not know, and
  `web/test/skin-switch.test.ts` holds the list to this.
- **A deployment may replace the list at build time** with `VITE_ENABLED_SKINS` (comma-separated, for example
  `console,terminal`). The Vite config runs the same check, so a bad value fails the build. CI does not set it.
- **Tests and the gate follow the list.** `SKINS` in `web/src/skins/index.ts` holds only skins that are on, so the
  contract tests loop over them. A test of one skin uses `skinTest` or `skinOff` from `web/test/support/skins.ts`
  and skips, with the reason, while its skin is off. The UI gate reads the list from `skin.ts` and refuses a `SKIN`
  that names a skin that is off.

## What a skin that is off still costs

- Its code stays in `web/src/skins/<id>/`, and it must still typecheck and build. A change to a model or a shared
  type must keep it compiling.
- It is still in the bundle, with its stylesheet, because the registry imports it. Its rules match only its own
  `html[data-skin]`, so they do not apply.
- Its messages stay in the catalogue, because its code still reads them.
- No test or gate checks it. Before a skin is switched on again, run its tests and the UI gate for it, and expect
  to fix what drifted while it was off.

## Consequences

- The console is the only face people see. The terminal rules in `AGENTS.md`, `web/DESIGN.md` and the UI gate's
  README apply only while the terminal is on.
- To retire a skin for good, delete its folder, its tests and its gate states, and remove its id from `SkinId`.

## Alternatives considered

- **Delete the terminal skin.** It is the smallest code base, but the owner wants the option to bring it back.
- **Hide only the chooser.** A stored choice or `?skin=terminal` would still wear the terminal, and every test and the
  gate would still pay for it.
