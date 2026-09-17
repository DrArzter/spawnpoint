# Adding a game

A game is a directory holding `game.sh` — constants plus functions — and its Compose file
([ADR-0034](../../docs/adr/0034-per-game-adapter.md)). The contract is in
[`_dispatch.sh`](_dispatch.sh); a world names its game in [the catalog](../worlds/catalog.json), and absence means
minecraft, byte-identically.

What follows is not the contract but the house rules for filling it in. Both were learned by getting Factorio wrong
first, and they cost nothing to apply to the next game.

## Assume the server authenticates nobody

`GAME_DEFAULT_AUTH` is a claim about **the server as this project runs it**, never about what the game supports.
Write `none` unless a player's identity is actually verified by the configuration in this repository, and let the
operator declare the stronger case per world.

Getting this wrong is not a cosmetic error: the gate-versus-auth invariant
([ADR-0033](../../docs/adr/0033-connectivity-as-a-strategy.md)) reads the default to decide whether a world may be
published without an overlay in front of it. An optimistic default silently permits an open server.

The trap has the same shape every time — a fact that frees the server from needing an account also removes its
ability to verify one:

| Game | Optimistic reading | What the configuration actually does |
| --- | --- | --- |
| Minecraft | Mojang accounts are verified | `online-mode=false` ([ADR-0022](../../docs/adr/0022-minecraft-account-as-linked-identity.md)) verifies nobody |
| Factorio | the server checks players against factorio.com | verification needs a *visible* server holding credentials; this one is hidden, which is why it needs no account |
| Project Zomboid | Steam identities are verified | true only with Steam authentication enabled and the server registered with Steam; a direct-connect server without it verifies nobody, and this project has not exercised that configuration |

## Build the client pack unless the game genuinely cannot use one

Publication builds `releases/<game>/<preset>/<release>/client.zip` from the release's own mod files and the game's own install notes
(`upload-release.sh`). Automatic in-game delivery — Factorio's mod sync, Zomboid's Workshop download — is the normal
path, not a guarantee: a client that cannot reach the upstream source still needs the exact files, and the release
already holds them, so the pack costs one zip.

Write the install notes in the game's own vocabulary — its mods folder on each platform, and why old files are
deleted rather than merged. Never let another game's instruction stand in: `write_install_notes` fails loudly for a
game it does not know, deliberately.

Skip the pack only for a game whose players install nothing locally — a server-side plugin loader, for example
(distribution model E in [docs/prior-art.md](../../docs/prior-art.md)).

## Do not trust an undocumented response format

The player probe's parser decides whether a server is empty, and "empty" stops an instance. When a game's reply
wording cannot be verified against documentation — Project Zomboid's `players` output is the case that forced this —
make the parser **self-checking** rather than optimistic: read the count one way, count the listed players another,
and refuse unless they agree. A refusal is read as "not idle" by the probe and as a refusal by the stop, so the
failure costs a few minutes of instance time. A wrong count in the other direction stops a server with people on it.

## Run on a slot, or say why not

A placed session ([ADR-0054](../../docs/adr/0054-place-a-session-on-a-host-with-room.md)) arrives with
`SPAWNPOINT_SLOT`. The dispatcher gives it a Compose project named for its world, the ports of its slot
(`SPAWNPOINT_GAME_PORT`, `SPAWNPOINT_RCON_PORT`, `SPAWNPOINT_GAME_PORT_2`) and the memory limit of its footprint; a
module takes part by:

- publishing its host ports from those variables, defaulting to the game's own so an unplaced session is unchanged —
  the container side never changes;
- naming `GAME_RCON_PORT`, and reading the host side of RCON from `SPAWNPOINT_RCON_PORT` where the probe speaks from
  the host;
- shipping `GAME_FOOTPRINT_COMPOSE_FILE`, a two-line overlay that turns `SPAWNPOINT_FOOTPRINT_MEMORY_MIB` into the
  game container's `mem_limit`;
- keeping its observability part in two files: `GAME_OBSERVABILITY_COMPOSE_FILES` carries the tier inside an unplaced
  session, as it always has; `GAME_HOST_OBSERVABILITY_COMPOSE_FILE` is what a placed session includes instead — an
  overlay that puts the `spawnpoint.scrape`, `spawnpoint.scrape_port` and `spawnpoint.scrape_job` labels on the game's
  exporter and joins it to the `spawnpoint-observability` network, where the host's own tier
  (`observability/compose.host.yaml`) finds it. A game with no exporter declares neither;
- declaring `GAME_SLOTTABLE`. `true` means a client connects to the port the address names and the server announces
  no other. Project Zomboid tells its clients to continue on a second port, so it is `false` until its ini can be
  rendered from the slot, and a slot other than zero is refused for it with that reason.

## The rest of the checklist

- `game_save` flushes the live game using its own protocol. `game_save_paths`, `game_save_sentinel` and
  `game_archive_sentinel_regex` describe **this** game's save. A borrowed
  sentinel passes tests and loses worlds.
- The player probe's `key=value` output never varies by game; only what produces the values does.
- `game_tick_time_ms` prints milliseconds per tick for `scripts/measure-tick.sh`, the reading the acceptance of
  [ADR-0054](../../docs/adr/0054-place-a-session-on-a-host-with-room.md) compares alone and beside a neighbour;
  a game that cannot report one exits 2 and says why, as Project Zomboid does.
- Reuse packaging rather than building an image ([ADR-0005](../../docs/adr/0005-containerised-game-server.md)), pin
  it by digest, keep the game port off the public interface, and keep operator surfaces (RCON, telnet) on localhost.
- Cover the module in `server/tests/game-adapter-test.sh`: both parsers, the real transport against a fake server,
  dispatch through the catalog, the archive path, and the manifest axis.
