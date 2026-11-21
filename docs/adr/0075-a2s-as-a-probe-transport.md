# ADR-0075 — A2S as a probe transport

- Status: Proposed — implemented for Valheim; two host tests are open
- Date: 2026-11-21
- Milestone: cross-cutting, first used by the Valheim module
- Relates: [ADR-0034](0034-per-game-adapter.md), [ADR-0006](0006-on-demand-start-and-idle-shutdown.md),
  [ADR-0054](0054-place-a-session-on-a-host-with-room.md), [ADR-0074](0074-eggs-are-a-reference-not-a-runtime.md)
- Numbering: ADR-0070 to ADR-0073 can be taken by work that is still open on other branches; see ADR-0074.

## Context

The idle stop asks each game how many players are online. Minecraft, Factorio and Project Zomboid answer over RCON.
Many Steam games have no RCON, or none with a player list, but answer Steam's server query protocol, A2S, on a UDP
query port. Valheim is the first such game: its query port is always its game port plus one.

A2S has two queries that matter here. `A2S_INFO` returns, among other fields, the number of players (bots included)
and the number of bots. `A2S_PLAYER` returns one entry per player. Either query can first answer with a challenge
that the client must send back. Long replies arrive split over several packets.

The probe's parser decides whether a server is empty, and "empty" stops an instance. A2S is documented by Valve, but
each game fills the replies from its own code, and some do it badly: the Valheim image notes that a crossplay server
always reports zero players. So a count from one query alone is not to be trusted
([server/games/README.md](../../server/games/README.md), "Do not trust an undocumented response format").

## Decision

**One shared client, `server/games/_probes/a2s-client.py`, speaks A2S from the host.** Standard library only, in the
style of the Factorio RCON client. It sends `A2S_INFO`, then `A2S_PLAYER`, answers a challenge on either, and prints
four `key=value` lines: `info_players`, `info_max_players`, `info_bots` and `player_entries`. It reads past player
names and never prints them. It refuses a split reply, a truncated reply, a player list longer or shorter than its own
count, and an unknown reply type. Exit codes: 0 printed, 2 usage, 3 no answer, 4 an answer it does not understand.

**The parser is self-checking: the two queries must agree.** `server/games/_probes/a2s.sh` reads the four lines and
prints `info_players - info_bots` only when `player_entries` equals `info_players` and the bots are not more than the
players. Anything else is a refusal. The probe reads a refusal as "not idle" and the stop reads it as a refusal, so a
wrong guess costs a few minutes of instance time, never a world with players in it. A game whose list leaves its bots
out therefore never reads as idle while a bot is in; it fails closed.

**Bots do not count.** An idle stop asks whether people are playing.

**The query port stays on the host.** A game module publishes its query port on `127.0.0.1` only. Where the game has
no RCON, the query port takes the slot's RCON port ([ADR-0054](0054-place-a-session-on-a-host-with-room.md)): the
module names it as `GAME_RCON_PORT`, and the host side is the game port plus one in every slot, as the game expects.

**The server stays unlisted.** A module sets the game's "public" or "listed" option off. Every world on a disposable
host has a public address all the same; listing would only add it to Steam's server browser.

## Consequences

**Good**

- A new Steam game with a query port needs no new transport: its module names the host and port.
- The probe keeps its fail-closed meaning, and a game that fills A2S badly is found as "never idle", not as a stopped
  server with players on it.
- No player name leaves the client.

**Bad, or risky**

- Two facts are not proven on a host yet. They gate the first Valheim world:
  1. An unlisted Valheim server answers A2S on its query port from the host, on `127.0.0.1`.
  2. Valheim's "Join IP" works when only the game port is public. If the client also needs the query port, the port
     must be public too, which the fleet's security group cannot yet express (one port per game module).
- It is not proven that Valheim's `A2S_PLAYER` lists every player. If it lists none, the agreement rule refuses every
  probe with a player online, and the world never stops by itself while somebody is in it. That fails closed, but it
  turns off the idle stop for such sessions. It shows in the first session with a player.
- The local check on 2026-11-21 could not run the server: the image's 32-bit SteamCMD crashed under amd64 emulation on
  an arm64 workstation. Both open facts need an x86 host.
- A split reply is refused. A server with many players or long names could send one; no candidate game is that large
  yet.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Trust `A2S_INFO` alone | One number from code we do not control decides whether to stop a server with people on it |
| Count UDP datagrams, as the Valheim image does for an unlisted server | A heuristic: a port scan or a query reads as a player, and a quiet player can read as none |
| Read the server log for joins and leaves | Wording changes between versions, and a missed line keeps a count wrong until the next restart |
| A third-party A2S library | A new dependency on every host for two short queries |
