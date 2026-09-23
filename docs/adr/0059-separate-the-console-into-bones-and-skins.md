# ADR-0059 — Separate the console into bones and skins, and hold every skin to one contract

- Status: Accepted — implemented in the same change, 2026-09-23
- Date: 2026-09-23
- Milestone: M4
- Extends: [ADR-0048](0048-one-instance-per-active-world.md) and [ADR-0053](0053-tell-not-built-apart-from-broken.md)

## Context

The panel's look and its behaviour grew up in the same files. A screen read the control plane, decided which verbs a
world may take and why one is refused, and drew the table those verbs sit in. Changing the look therefore meant
rewriting the screens, and every attempt at a bolder face risked the behaviour that had been checked and shipped.

The owner asked for the two to come apart: keep the bones, let any face be built on them, and hold every face to the
same list of controls («дать возможность делать какую угодно морду, лишь бы поддерживала требуемый список кнопок»).

## Decision

The web console is two layers with a typed seam between them.

**Bones** (`web/src/core/`) own state, data and decisions, and produce nothing visual. `useConsole` holds what the old
shell held: route, scope, control-plane state, pending operations, what is open over the page. The page controllers in
`Console.tsx` build one model per page and hand it to the skin. `worlds.ts` decides which verb a world takes and why it
may be refused, what stands in an empty cell, and what each row may do. `data.ts` loads what a page needs while it is
shown: backups, metrics, access requests, roles, subscriptions, invitations, linked sign-in methods. `forms.ts` keeps
the drafts of the sheets and the confirmation. Every choice a person can make reaches the skin as an `Action`: a
stable id, a label, `run`, and `disabled` with the reason as `hint`.

**Skins** (`web/src/skins/<id>/`) are pure views of those models, one component per surface, assembled as a `Skin`
(`skins/skin.ts`). The look the panel shipped with is now `skins/console`, the Cloud console face, and behaves as it
did. A skin may reuse the shared primitives in `components/ui` or draw its own. It may not reach past its model into
the API or the domain helpers. Which skin is worn is remembered beside theme and accent (`spawnpoint.skin`, `?skin=`),
and will follow the account when a second skin ships.

**The contract** (`web/test/skin-contract.test.ts`) renders every skin against fixture models whose actions are spies
and requires each action to reach the markup as an element carrying `data-action` with the action's id. A face without
Stop, Approve or Restore fails CI. Models carry an action only when it is offered: a retry exists only while a load
failed, a sheet's close only while it is open, so the test measures what a person could reach.

The tests import the panel's own `.tsx` through a small loader (`web/test/support/`) built on Vite's transformer, so
no new dependency was added for it.

## Consequences

- The Google Cloud console grammar recorded in PRODUCT.md is one skin, not the panel. A terminal skin is the next.
- A new verb goes into a model first, then into every skin; the contract test names the skin that forgot it.
- Two skins are two sets of views to keep current. The seam makes that mechanical, not free.
- The front door, sign-in, the boot card and the invitation and email-action screens are still shared views outside
  the skin; they join the contract when a second skin needs them to differ.
