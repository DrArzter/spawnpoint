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
| Project Zomboid | Steam identities are verified | true only with Steam authentication enabled and the server registered with Steam; a direct-connect server without it verifies nobody |

## Build the client pack unless the game genuinely cannot use one

Publication builds `packs/<release>.zip` from the release's own mod files and the game's own install notes
(`upload-release.sh`). Automatic in-game delivery — Factorio's mod sync, Zomboid's Workshop download — is the normal
path, not a guarantee: a client that cannot reach the upstream source still needs the exact files, and the release
already holds them, so the pack costs one zip.

Write the install notes in the game's own vocabulary — its mods folder on each platform, and why old files are
deleted rather than merged. Never let another game's instruction stand in: `write_install_notes` fails loudly for a
game it does not know, deliberately.

Skip the pack only for a game whose players install nothing locally — a server-side plugin loader, for example
(distribution model E in [docs/prior-art.md](../../docs/prior-art.md)).

## The rest of the checklist

- `game_save_paths`, `game_save_sentinel` and `game_archive_sentinel_regex` describe **this** game's save. A borrowed
  sentinel passes tests and loses worlds.
- The player probe's `key=value` output never varies by game; only what produces the values does.
- Reuse packaging rather than building an image ([ADR-0005](../../docs/adr/0005-containerised-game-server.md)), pin
  it by digest, keep the game port off the public interface, and keep operator surfaces (RCON, telnet) on localhost.
- Cover the module in `server/tests/game-adapter-test.sh`: both parsers, the real transport against a fake server,
  dispatch through the catalog, the archive path, and the manifest axis.
