# ADR-0022 — The Minecraft account is a third linked identity, and the whitelist is derived from the link table

- Status: Proposed
- Date: 2026-08-11
- Revised: 2026-08-11 — the owner has decided on `online-mode=false`. The first draft of this ADR asserted that
  offline mode was "a decision never to make". That assertion is withdrawn; the decision is the owner's, and this
  revision records what it actually costs and what has to change because of it
- Milestone: M4
- Extends: [ADR-0019](0019-account-linking.md)

## Context

Start with how Minecraft identity actually works, because the two modes behave differently and the difference
decides the whole design.

`whitelist.json` stores `{uuid, name}` pairs, and the **UUID is the key**. The `name` field is a cached label. So
the whitelist is UUID-keyed in both modes. What differs is where the UUID comes from:

| | `online-mode=true` | `online-mode=false` (chosen) |
| --- | --- | --- |
| UUID source | The Microsoft/Mojang account, verified against the session servers on every join | Derived from the username by a fixed algorithm, locally |
| Can somebody join as a name they do not own? | No. Session verification prevents it cryptographically | **Yes.** There is nothing to verify against |
| What the whitelist means | "These accounts may join" | "These *names* may join" |

Under the chosen configuration, the original intuition — that the whitelist is name-based — is therefore correct.
The offline UUID is a pure function of the username, so whitelisting a UUID is exactly equivalent to whitelisting
a name.

The consequence has to be stated plainly: **with offline mode, the whitelist is not an authentication boundary.**
Anybody who can reach the port and knows a whitelisted username can join as that player, with their inventory,
their builds and their permissions. The whitelist keeps out unknown *names*, not unknown *people*.

That does not make the configuration wrong. It relocates the security boundary. If the server is not reachable
from the open internet, network membership becomes the authentication, and the whitelist goes back to being what
it is good at: bookkeeping about who is expected. That relocation is the subject of
[ADR-0024](0024-connectivity-modes.md), and it is a hard dependency of this one.

What is still missing, and is the original point of this ADR: nothing connects a Minecraft identity to the
internal identity from [ADR-0019](0019-account-linking.md), so the whitelist is a second list, maintained by hand,
that drifts. Somebody removed from the group in chat stays in `whitelist.json` until a human remembers.

## Decision

**`online-mode=false`**, as decided by the owner. Therefore:

- **The network is the access control**, not the whitelist. This ADR is only safe in a connectivity mode that
  restricts who can reach the port. See [ADR-0024](0024-connectivity-modes.md).
- **The whitelist remains, and stays derived.** It is bookkeeping and a guard against accidents, not a security
  control, and it is described as such wherever it appears so nobody mistakes it for one.

**The Minecraft identity becomes a third linked identity**, alongside Discord and Telegram, and the whitelist is a
**projection of the link table** rather than a list anybody edits.

Binding, on the account page: the player enters the username they play under, and its offline UUID is computed
locally and stored against their internal identity. No external API is involved, because in offline mode the UUID
is a function of the name — one of the few simplifications this configuration buys.

Constraints, which are now doing more work than before:

- One Minecraft name per identity. A second needs owner approval.
- A name may belong to exactly one identity. Conflicts are refused, not merged.
- Only a signed-in, linked identity can create a binding.

Reconciliation: on server start, and on every bind, unbind or unlink, `whitelist.json` is regenerated from the
link table and reloaded. Unlinking someone in the panel removes them from the game.

Server settings that are part of this decision:

- `white-list=true` and `enforce-whitelist=true`, so a player removed from the list is kicked rather than left in
  the world until they disconnect.
- Operator privileges are **not** derived, and are kept to the minimum. In offline mode an op entry is a name that
  anybody able to reach the port can claim, so `ops.json` is the most dangerous file on the server.

## The one-way door

Worth its own section, because it is the part that is expensive to discover later.

Player save data is keyed by UUID. Offline and online UUIDs for the same person are different values. So switching
`online-mode` later does not just invalidate `whitelist.json` and `ops.json` — it orphans every player's inventory,
position and advancements, because the server looks for a UUID that no longer matches.

Changing this setting after people have played therefore needs a deliberate UUID remapping of the save data, not a
configuration edit. Decide it at M0, write it down, and treat it as fixed for the life of a world. If a switch is
ever wanted, the honest path is a new world. See [ADR-0023](0023-multiple-worlds.md).

**For the first world, the door has already been walked through.** This project will host an existing, long-played
world whose player data is keyed by offline UUIDs. Switching it to online mode would orphan everybody's inventories,
positions and advancements. So `online-mode=false` is not a preference to confirm for that world — it is a constraint
inherited from its history, and the only way to run a world in online mode is to start a new one.

## Consequences

**Good**

- Players without a paid account can join, which is presumably the reason for the choice, and it is a real one.
- No dependency on Mojang session servers at join time. The server comes up and works even when they do not.
- The binding is a local computation rather than an API call, so it cannot fail because a third party is down.
- One source of truth for who is expected: remove someone once and they lose the panel, the bots and the game.
- Renames are cheap to handle, because the binding is the name and the UUID follows from it.

**Bad, or risky**

- **Impersonation is possible for anybody who can reach the port.** This is the whole cost, and it is not
  reducible at the Minecraft layer.
- An op entry is a name anybody reaching the port can claim.
- Within the group, one member can trivially join as another. That is a social problem rather than a technical
  one, but it is worth knowing before somebody discovers it as a prank.
- Switching `online-mode` later is a save-data migration, not a setting change.
- Skins and capes do not resolve from Mojang by default, and a few mods behave differently in offline mode.

**Mitigations**

- The network gate is not optional. A connectivity mode that exposes the port to the internet must not be combined
  with this setting for a world anybody cares about. See [ADR-0024](0024-connectivity-modes.md).
- Keep `ops.json` empty or near-empty, and use RCON through the control plane for administration instead of
  in-game operator commands. RCON is already how the automation talks to the server.
- Backups are the answer to griefing as well as to corruption, and they already exist with graded retention. See
  [ADR-0010](0010-world-persistence-and-backups.md).
- Reconciliation is additive-then-subtractive, logged, and refuses to write an empty whitelist — an empty result
  is a bug, not an instruction.
- Document the mode and the one-way door in the runbook, next to the world it applies to.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| `online-mode=true` with a UUID-keyed whitelist | Cryptographic protection against impersonation, and no network gate strictly required. Excludes players without a paid account, which is the constraint that decided this. The stronger option on security alone, and available by starting a *new* world if that ever becomes the priority |
| Offline mode with the port open to the internet | The configuration that gets small servers griefed. Explicitly rejected: offline mode is only adopted here *together with* a network gate |
| Offline mode plus an in-game password mod | **Reconsidered — see below.** This row originally dismissed it on the grounds that the network gate solves the problem properly. That reasoning holds only while there *is* a network gate, and [ADR-0024](0024-connectivity-modes.md) now treats the public-address mode as a real option |
| Prove ownership with an in-game code before binding | Meaningful only in online mode. In offline mode there is no ownership to prove: the name is the identity |
| Keep the whitelist manual | Zero work, and correct today at five players. Two lists that drift, and removal depends on somebody remembering |

## Dormant: the in-game login branch

> **Nothing below is work.** [ADR-0024](0024-connectivity-modes.md) chose ZeroTier, and an overlay makes this entire
> branch unnecessary — the port is not reachable, so there is nothing to authenticate at the Minecraft layer. It is
> kept because it is the fallback if connectivity ever moves to a public address, and because the reasoning is sound
> and would otherwise be re-derived.
>
> **The trigger is a change to [ADR-0024](0024-connectivity-modes.md), not a spare evening.** Until then the correct
> amount of effort here is zero: no mod, no search for one, no password store. The whitelist stays what this ADR
> already says it is — bookkeeping, not a security control.

## If there is no network gate, an in-game login mod is the substitute

[ADR-0024](0024-connectivity-modes.md) makes connectivity pluggable, and the public-address mode is genuinely on the
table. Without an overlay, the chain that reaches a world is: a scanner finds the address during a session, reads a
valid username from the status ping's player sample, and connects as that player. **An in-game login mod breaks the
last step** — the name gets you a login prompt rather than the world.

So the two are alternatives for the same job, and exactly one is needed:

| Posture | What protects the world |
| --- | --- |
| Overlay connectivity | Network membership. Nobody unknown reaches the port at all |
| Public address | An in-game login mod. The port is reachable; the world is not |

**It does not protect the bill, and that is a separate mitigation.** A player waiting at a login prompt is still
*connected*, so the idle watchdog still counts them and the server is still held open — unless the count is taken from
authenticated players specifically, which is mod-dependent. The hard session cap in
[ADR-0006](0006-on-demand-start-and-idle-shutdown.md) is what closes that, and it closes it either way. **Login mod for
the world, session cap for the bill; neither substitutes for the other.**

Honest costs, since the original dismissal was not entirely wrong:

- A password store and a reset path, for five people, owned by the owner.
- `/login` every session. Small, and the kind of friction people mention every time.
- It is a mod, so it lives in the release manifest and a bad update breaks logins for everybody at once. Server-side
  only, though, so it does not need to reach the client pack.
- Historically this class of plugin has had bypass bugs, which is why it is a substitute for a network gate rather than
  an addition to one.

### Writing the mod, rather than finding one

Worth taking seriously, and it qualifies an earlier objection in this ADR. "Reinventing authentication badly" was fair
against a password plugin. It is much weaker here, because **the mod would not be doing the authentication.**

The split is the point:

| Lives in the mod | Lives in the control plane |
| --- | --- |
| Hold a connecting player. Release them on command. Kick them on timeout | The link table lookup, which chat account to ask, the approval, remembering a familiar address, the audit trail |

So the mod is a **gate actuator**, not an authentication system. No password store, no registration, no reset, no
sessions — all of that already exists elsewhere in this design. What remains is small: an event handler, a server
command RCON can call, and a timer. Existing auth mods are the wrong shape anyway, because they are built around a
password typed in chat, which is exactly the part being replaced.

**The tempting no-mod version has a specific hole.** It looks like this: leave the player un-whitelisted, watch the
rejected join in the log, ask the linked account, add the name to the whitelist on approval, and have them reconnect.
Zero mod code, using only the vanilla whitelist and RCON, both already present. The hole is that **the whitelist is
keyed by name, so the approval window is name-scoped**: once the name is added, whoever reconnects with it first gets
in — including the impostor whose attempt triggered the approval in the first place. A mod can bind the release to the
*connection* rather than to the name, and that is precisely why it is worth the code.

**The risk that matters is fail-open.** If the hold has a gap — an unhandled interaction, a command that still works, a
movement path not cancelled — the gate is decoration and nobody notices, because it fails silently in the permissive
direction. That is what to test adversarially rather than assume: try to break a block, drop an item, use a command and
send a chat message while held.

**Sequencing, given everything else in this repository.** A Forge mod means Java, Gradle and a toolchain that appears
nowhere else here, and it sits on the critical path of playing — a bug means nobody gets in. It is also **only needed if
the public-address mode is chosen**; with the overlay there is nothing to build. So: not before the AWS side exists, and
not at all if connectivity settles on the overlay.

**To verify before relying on any of this:** what exists for **Forge 1.20.1** specifically, and whether any of it
exposes a force-login command over RCON. Most of the well-known implementations target the Bukkit family. Sinytra
Connector is already bridging Fabric mods here, which may widen the options — that is a search, not an assumption. If
nothing exposes an external release command, the chat-approval design collapses back to a password, and the network
gate becomes the better answer again.

## Open questions

- Whether one world should run in online mode after all — for example a long-lived build world where impersonation
  matters most — while others stay offline. The per-world model in [ADR-0023](0023-multiple-worlds.md) makes this
  possible, and the one-way door makes it a per-world decision taken at creation.
- Whether the panel should show in-game presence, which needs the binding on the hot path of the idle check.
- Whether a player may unbind their own name, or only the owner. Leaning owner-only, because self-unbinding is a
  way to escape an in-game consequence.
- Whether to record, per session, which linked identity was seen in game — useful, and in offline mode it is a
  claim rather than a fact, which the UI should not obscure.

## Sources

Verified 2026-08-11.

- `whitelist.json` format, UUID as the key, and offline-mode UUID derivation: <https://minecraft.wiki/w/Whitelist.json>
