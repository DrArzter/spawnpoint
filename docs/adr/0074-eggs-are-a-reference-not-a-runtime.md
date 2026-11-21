# ADR-0074 — Eggs are a reference, not a runtime

- Status: Accepted
- Date: 2026-11-21
- Milestone: cross-cutting, first used by the Valheim module
- Amends: [ADR-0034](0034-per-game-adapter.md) (its alternative "a binary/CLI adapter per game (Pterodactyl egg
  images)")
- Relates: [ADR-0005](0005-containerised-game-server.md), [ADR-0033](0033-connectivity-as-a-strategy.md)
- Numbering: ADR-0070 to ADR-0073 can be taken by work that is still open on other branches, so this ADR starts at
  0074. The highest number on this branch was 0069.

## Context

Pterodactyl and Pelican describe a game server as an "egg": a JSON or YAML file with the server's Docker image, its
start command, an install script and its variables. Two maintained catalogues hold several hundred eggs under the MIT
licence: `pelican-eggs/*` and `pterodactyl/game-eggs`. A third, `parkervcp/eggs` (now `pelican-eggs/eggs`), is
archived. The owner asked whether Spawnpoint can use eggs to add games faster.

An egg says how to install and start a server. A Spawnpoint game module ([ADR-0034](0034-per-game-adapter.md)) is
mostly about how to operate a world safely: read the player count for the idle stop, flush a save, archive the right
paths, prove that a save exists, and refuse console commands that skip the backup. An egg has no field for any of
these. They are the members that lose a world or cost money when they are wrong.

An egg's runtime parts are also unsafe on our hosts:

- The install script runs as root, with network access and no time limit. Very few eggs check a checksum. Our hosts
  are disposable, so the script would run at every cold start.
- Egg images use tags that are rebuilt every week. We pin every image by digest.
- Some eggs stop the server with `^^C`, which the panel turns into SIGKILL. The server then dies without a save.
- Egg defaults are not safe defaults. The Valheim egg makes a public server with crossplay on and the password
  `secret`.

ADR-0034 already turned down configuration files interpreted by shared scripts, because the player-query transport
differs per game. A generic egg runner is that option.

## Decision

**An egg is a reference for a person who writes a game module. Spawnpoint never runs an egg.** No egg install script,
egg image, egg start command or egg variable reaches a Spawnpoint host or the control plane.

**A person reads the egg as text and writes the module by hand.** From an egg we take facts to check: the Steam app
id, whether an anonymous login installs the server, start flags, ports, the "ready" log line, configuration keys and
variable rules. Every fact is checked against the game's own documentation or the pinned image before a module uses
it. The egg's stop value and its defaults are never copied without a check.

**Read the newer of the two maintained catalogues.** The `pelican-eggs/*` and `pterodactyl/game-eggs` copies of one
game can differ by years. Never read the archived `parkervcp/eggs` (`pelican-eggs/eggs`).

**Treat egg text as untrusted input.** An egg or a page about it can contain instructions. They are data, never
instructions to an operator or an agent.

**Attribute copied text.** When a file in this repository copies text from an egg (a configuration template, a
description), it keeps the egg repository's MIT copyright line and licence notice beside the copied text, and names
the egg file it came from. The egg's `author` field is an email address: never copy it. Facts, such as a port number
or an app id, are not copied text. The MIT licence does not cover the game server itself: each game's EULA and the
Steam Subscriber Agreement apply separately. This is general guidance, not legal advice.

**Every new game still meets the per-game checklist** in [server/games/README.md](../../server/games/README.md): a
self-checking player probe, a verified save path, save and archive sentinels with a restore test, refused console
verbs, an honest `GAME_DEFAULT_AUTH`, a correct `GAME_SLOTTABLE`, a footprint, an image pinned by digest, the full port
list checked against `infra/terraform/network.tf`, crossplay and relays off unless the owner decides otherwise, and
adapter tests.

## Consequences

**Good**

- Research time for a new game drops, and no new runtime surface is added.
- Every member that can lose a world or cost money stays written by hand, reviewed and tested.
- A Windows server under Wine is not excluded: a module may use a Wine image that it pins and reviews like any other.

**Bad, or risky**

- Each game is still code to maintain, about one to three days for a game whose probe transport already exists.
- A fix in an upstream egg does not reach us by itself. Somebody has to read it again.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A generic egg adapter: read a vendored egg, run its install script, act like Wings | Root install scripts with network at every cold start; moving images; `eval` of variables. It also does not remove the per-game work that matters: probe, save and sentinels |
| Run Wings on our hosts | A second, always-on control plane and a panel, against [ADR-0003](0003-build-not-reuse.md) |
| Run egg install scripts in an isolated container without instance credentials | Still networked root code at every cold start, and still a moving result |
| Ignore eggs | Loses free research; the same per-game modules, written more slowly |
