# ADR-0022 — The Minecraft account is a third linked identity, and the whitelist is derived from the link table

- Status: Proposed
- Date: 2026-08-11
- Milestone: M4
- Extends: [ADR-0019](0019-account-linking.md)

## Context

A correction first, because the design depends on it. The whitelist is **not** name-based.

`whitelist.json` stores `{uuid, name}` pairs, and the UUID is the key. A player who renames stays whitelisted,
because the UUID does not change; the `name` field is a cached label for humans. On an **online-mode** server the
UUID is the Microsoft/Mojang account UUID, and the server verifies each join against the session servers. So the
whitelist is already anchored to an account, not to a nickname.

That changes the shape of the problem. Two controls already stop a stranger:

| Control | What it actually prevents |
| --- | --- |
| `online-mode=true` | Impersonation. Nobody can join as a UUID they do not own, whatever name they type |
| Whitelist by UUID | Anybody not on the list joining at all |

The important corollary: with `online-mode=false` both collapse at once. UUIDs are then derived from the
username by a fixed algorithm, so anybody can claim any name and the whitelist becomes decoration. Offline mode
is therefore not a configuration option in this project; it is a decision never to make.

What is genuinely missing is not access control but a **binding**. Nothing connects a Minecraft account to the
internal identity from [ADR-0019](0019-account-linking.md), so the whitelist is a second list, maintained by
hand, that drifts from the first. Somebody removed from the group in Discord stays in `whitelist.json` until a
human remembers.

## Decision

The Minecraft account becomes a **third linked identity**, alongside Discord and Telegram, and the whitelist is a
**projection of the link table** rather than a list anybody edits.

Binding, on the account page: the player enters their Minecraft username, it is resolved to a UUID, and the UUID
is stored against their internal identity. Constraints do the work:

- One Minecraft account per identity. A second one needs owner approval.
- A UUID may belong to exactly one identity. Conflicts are refused, not merged.
- Only a signed-in, linked identity can create a binding at all.

Reconciliation: on server start, and on every bind, unbind or unlink, the whitelist is regenerated from the link
table and reloaded. Unlinking someone in the panel removes them from the game.

Server settings that make this real, and that are part of the decision:

- `online-mode=true`, permanently.
- `enforce-whitelist=true`, so a player removed from the list is kicked rather than left in the world until they
  disconnect.
- Operator privileges are **not** derived. `op` is a much larger privilege than joining, and it stays manual.

## What this does and does not buy

Worth stating precisely, because the intuitive reading is wrong.

**The access control is the pair "only authorised identities may add entries" plus `online-mode=true`.** A
stranger cannot get in, because they cannot create a whitelist entry and cannot impersonate one that exists.

**The binding is not proof of ownership.** A player could enter a username they do not own. The consequence is
mild and worth walking through: the entry is useless to them, because they still cannot pass session
verification as that UUID; and the uniqueness constraint means the real owner cannot then be bound by somebody
else, which surfaces as a visible conflict rather than a silent compromise. So an unproven claim costs a wasted
slot and a confusing error, not access.

**A linked player can still vouch for somebody.** Nothing here stops a group member binding an account that is
not theirs and handing it over. That is a policy question about who is trusted, not a hole in the mechanism, and
the one-account cap plus owner approval for extras is the proportionate answer at five players.

## Consequences

**Good**

- One source of truth for who may play. Remove someone once, and they lose the panel, the bots and the game.
- The whitelist stops being a file anybody edits, which is what makes drift possible.
- In-game presence becomes attributable to a person: the idle watchdog's player count, and any future in-game
  event in chat, can name the Discord or Telegram user rather than a nickname.
- Renames are free. UUID-anchored entries survive them, and the cached name is refreshed on reconciliation.
- Onboarding is self-service. A new player signs in, binds three accounts, and is playing.

**Bad, or risky**

- Another projection to keep correct. A reconciliation bug locks the whole group out of their own server.
- Resolving a username to a UUID depends on an external API. If it is unavailable, new bindings fail — though
  existing play is unaffected, which is the right way round.
- The binding is claimed rather than proven, as set out above.
- `enforce-whitelist=true` means a mistaken unlink kicks somebody mid-session.

**Mitigations**

- Reconciliation is additive-then-subtractive and logged, and it refuses to write an empty whitelist — an empty
  result is treated as a bug, not as an instruction.
- The owner keeps a documented manual path in the runbook, because a bug in the projection must not be
  unrecoverable.
- Bindings are cached, so an outage of the name-resolution API cannot affect anybody already bound.
- Unlink asks for confirmation and announces itself to the person concerned, as [ADR-0019](0019-account-linking.md)
  already requires.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Prove ownership with an in-game code: the panel shows a code, the player types it in chat on first join, and the UUID that actually joined is bound | The rigorous version, and symmetric with the `/link` code in [ADR-0019](0019-account-linking.md). Deferred, not rejected: it buys verified binding, and the analysis above shows an unproven claim costs a slot rather than access. Build it if a real conflict occurs, or when in-game events start being attributed to people by name |
| Microsoft sign-in on the panel, then read the Minecraft profile for the UUID | Cryptographic proof with no in-game step, and the "proper" answer. Requires a chain of token exchanges through Xbox Live to reach the Minecraft services profile, which is not a cleanly supported third-party integration and carries terms-of-use questions. Verify current feasibility before considering it seriously |
| Keep the whitelist manual, as most servers do | Zero work, and correct today at five players. Two lists that drift, and removal depends on somebody remembering |
| Derive the whitelist from the Discord server's member list directly | No binding step at all. Needs a Minecraft UUID from somewhere regardless, which is the problem this ADR exists to solve |
| `online-mode=false` with a whitelist | Occasionally suggested for convenience. It makes the whitelist meaningless, because UUIDs become a function of the username. Never |
| A proxy or authentication plugin in front of the server | Extra always-on component, and it duplicates what `online-mode` already does correctly |

## Open questions

- Which API resolves a username to a UUID, and its current rate limits and terms. Verify before implementation.
- Whether the panel shows the player's in-game presence — "you are online now" — which needs the binding to be
  read on the hot path of the idle check.
- Whether a player may unbind their own Minecraft account, or only the owner may. Leaning towards the owner
  only, because self-unbinding is a way to escape an in-game consequence.
- Whether `ops.json` should be derived from the owner role after all. Deliberately left manual for now.

## Sources

Verified 2026-08-11.

- `whitelist.json` format, and UUID as the key: <https://minecraft.wiki/w/Whitelist.json>
