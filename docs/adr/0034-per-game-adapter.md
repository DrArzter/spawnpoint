# ADR-0034 — A game is a module: data plus functions, with minecraft as the byte-identical default

- Status: Accepted
- Date: 2026-08-27
- Milestone: cross-cutting, first exercised by the Factorio world
- Materialises: the per-game adapter placeholder in [the index](README.md#decisions-still-to-record), whose own
  condition — *"write it when a second game is actually on the table"* — was met when Factorio became a world in the
  catalog
- Relates: [ADR-0023](0023-multiple-worlds.md) (worlds as units, one active at a time — a game rides the same axis),
  [ADR-0033](0033-connectivity-as-a-strategy.md) (the connectivity slice of the same idea),
  [ADR-0005](0005-containerised-game-server.md) (reused packaging per game)

## Context

The infrastructure was game-agnostic from the start; the control plane was Minecraft-shaped in a countable set of
places, mapped before building ([docs/prior-art.md](../prior-art.md)): the player probe's transport and parser, the
mod file extension and loader identity in release manifests, the save layout and its sentinels, and the Compose
service definition. Lifecycle V2, the workflows, the bot, notifications, guardrails and the backup mechanics touch
none of it.

Two shapes were available for the adapter. Configuration — a per-game data file the shared scripts interpret — reads
cleanly until the first game whose player query needs a different *transport*, not different values: Factorio's RCON
is spoken from the host (its image ships no in-container CLI), 7 Days to Die would bring telnet. Interpreting
transports from configuration is writing a worse shell in JSON.

## Decision

**A game is a directory: `server/games/<game>/` holding `game.sh` — constants plus functions — and the game's Compose
file.** The module contract:

| Member | Meaning |
| --- | --- |
| `GAME_COMPOSE_FILES`, `GAME_COMPOSE_SERVICE` | What a session runs, colon-listed relative to `server/` |
| `GAME_MOD_EXTENSION`, `GAME_LOADER_TYPE` | What a release contains and what its manifest carries as `loader.type` |
| `game_query_players_raw` | The transport: print the raw player-query response |
| `game_parse_player_count` | The parser: raw on stdin, an integer on stdout, non-zero on anything else |
| `game_save_paths`, `game_save_sentinel` | What to archive under the data directory, and what proves a save exists |
| `game_archive_sentinel_regex` | What a verified archive must contain to count as this game's save |

Consumers dispatch through `server/games/_dispatch.sh`: a world names its game in the catalog (`game` field), an
explicit `SPAWNPOINT_GAME` overrides for fixtures, **and absence means minecraft** — the minecraft module is the
original behaviour extracted verbatim, so every deployed workflow, which names no game, is byte-identical in
behaviour. The probe's `key=value` contract to the watchdog never varies by game; only what produces the values does.

Release manifests gain an optional `game` field (absent normalises to `"minecraft"` everywhere, so the published
releases stay valid and canonically comparable), the builder takes `RELEASE_GAME`, and the validators accept each
game's extension and loader pair. The `minecraft_version` field name stays and carries the game's version — renaming
a schema field costs more than the honesty note in [server/releases/README.md](../../server/releases/README.md).

Factorio is the first tenant, deliberately vanilla: a world in the catalog on the same host
([ADR-0023](0023-multiple-worlds.md) — one active at a time), `factoriotools/factorio` as the reused packaging, RCON
host-local with the password read from the file the server itself generates, the game port reachable only over the
overlay. Its mod-portal resolver (distribution model B in [docs/prior-art.md](../prior-art.md)) is the next slice,
not this one.

## Consequences

**Good**

- Adding a game is adding a directory, not editing five scripts — the five scripts now dispatch.
- The unsafe defaults problem is absent by construction: no game named means the exact pre-adapter minecraft path.
- The probe's fail-closed semantics (unavailable is never idle) are shared machinery, written once.
- Two latent bugs surfaced while threading the axis and are fixed by it: `download-release.sh` rejected the empty
  releases the vanilla worlds publish, and `verify-archive.sh` judged every archive by Minecraft's `level.dat`.

**Bad, or risky**

- Bash functions as a plugin interface have no type checker; the contract lives in this ADR, the dispatch header and
  the adapter test. Discipline, not tooling.
- Two games share the release validators through an extension union (`jar|zip`) rather than per-game exactness — a
  factorio release containing a stray jar would pass shape validation. The manifest's own hashes still gate what
  actually lands.
- `minecraft_version` carrying a Factorio version is a recorded wart.

**Mitigations**

- `server/tests/game-adapter-test.sh` exercises both modules' parsers, the real RCON round trip against a faked
  server, dispatch through the catalog, per-game archives and sentinels, and the manifest axis end to end.
- The V2 watchdog extracts the probe's values by line position; the forward note in
  [workflows/README.md](../../workflows/README.md) already marks the by-name parse as the change to make when a
  second game reaches the workflows.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Configuration files interpreted by shared scripts | Falls at the first transport change; a JSON that describes how to speak RCON-from-host versus telnet is a shell script wearing a costume |
| A binary/CLI adapter per game (Pterodactyl egg images) | The right shape at ecosystem scale; a directory of bash matches this project's host contract (`key=value`, exit codes) and its size |
| Fork the scripts per game | The zomboid-control-panel of options: honest at one game, unmaintainable at three |

## Open questions

- The per-world instance shape (Factorio is happy far below the current host; 7 Days to Die wants the 16 GiB shape) —
  the catalog is the natural home when it matters.
- Whether `game_query_players_raw` should also carry the stop-side "who is online" listing for notifications, or a
  count stays enough.
- The factorio mod-portal resolver and how `mod-list.json` travels with a release payload — the next slice's design
  question (the manifest's `server.mods` array only carries mods today).
