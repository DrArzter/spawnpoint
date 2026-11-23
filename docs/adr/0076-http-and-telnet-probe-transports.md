# ADR-0076 — HTTP and telnet probe transports

- Status: Accepted — HTTP implemented for Palworld; telnet not built yet
- Date: 2026-11-21
- Milestone: cross-cutting, first used by the Palworld module
- Relates: [ADR-0034](0034-per-game-adapter.md), [ADR-0006](0006-on-demand-start-and-idle-shutdown.md),
  [ADR-0033](0033-connectivity-as-a-strategy.md), [ADR-0054](0054-place-a-session-on-a-host-with-room.md),
  [ADR-0063](0063-run-console-commands-through-one-ssm-document.md), [ADR-0074](0074-eggs-are-a-reference-not-a-runtime.md),
  [ADR-0075](0075-a2s-as-a-probe-transport.md)
- Numbering: ADR-0070 to ADR-0073 can be taken by work that is still open on other branches; see ADR-0074.

## Context

The idle stop asks each game how many players are online, and the stop asks the game to save. Minecraft, Factorio and
Project Zomboid answer over RCON, Valheim over A2S ([ADR-0075](0075-a2s-as-a-probe-transport.md)). Two more transports
cover the next candidate games:

- **HTTP.** Palworld has a REST API with `/players`, `/metrics`, `/save` and `/shutdown`, behind HTTP basic
  authentication. Its RCON is deprecated and "scheduled to stop functioning in an upcoming update"
  (<https://docs.palworldgame.com/api/rcon/>). Satisfactory has an HTTPS API with a player count.
- **Telnet.** 7 Days to Die and Soulmask take admin commands over a telnet port with a password.

Both carry a credential in clear text, or close to it. The Palworld documentation says of its REST API: "These APIs
are not designed to be exposed directly to the Internet" (<https://docs.palworldgame.com/api/rest-api/palwold-rest-api>).
Every world on a disposable host has a public address ([ADR-0033](0033-connectivity-as-a-strategy.md)).

## Decision

**The endpoint stays on the host.** A game module publishes its HTTP or telnet port on `127.0.0.1` only. The port
takes the slot's RCON place ([ADR-0054](0054-place-a-session-on-a-host-with-room.md)): the module names it as
`GAME_RCON_PORT`, and the host side follows the slot. No player surface, security group or overlay rule carries it.

**The credential lives in the host's runtime `.env`.** It is set by the operator as an SSM parameter and rendered into
the `.env` with the other host secrets, as `ZOMBOID_RCON_PASSWORD` is. Compose passes it to the image, and the probe
reads it from the environment or from the same `.env`. It is never a world setting and never in a world's archive.

**One shared HTTP client, `server/games/_probes/http-client.py`, speaks from the host.** Standard library only. It:

- accepts `http` on a loopback address with an explicit port, and nothing else;
- takes the user and password from its environment, never from its command line, which every user of the host can
  read;
- does not follow a redirect and does not use a proxy, so the credential cannot leave the host;
- prints the body of a 2xx answer as it came, and refuses everything else.

Exit codes are those of the A2S client: 0 printed, 2 usage, 3 no answer, 4 an answer it does not take (a status other
than 2xx, a redirect, a body over 1 MiB). `server/games/_probes/http.sh` reads the credential and calls the client.

**Each game keeps its own parser, and the parser is self-checking.** The transport is shared; the trust is not
([server/games/README.md](../../server/games/README.md)). The game module turns its replies into `key=value` counts
in the transport, so no player name, account or address reaches the probe's output or its log. The parser prints a
count only when two readings agree. For Palworld these are `/metrics` `currentplayernum` and the length of the
`/players` list.

**Save through the API where the game offers it.** `game_save` calls the game's save endpoint and fails when the call
fails, so the stop refuses rather than archives an unsaved world.

**Telnet follows the same rules when it is built.** Localhost only, the password in the host `.env`, a shared client in
`server/games/_probes/` with its own fake-server test, and a self-checking parser per game. No telnet client is built
by this ADR; the first telnet game (slice 4 of the egg plan) builds it.

## Consequences

**Good**

- Palworld needs no RCON, which its maker is removing.
- A new HTTP game needs no new client: its module names the port, the path, the user and the `.env` key.
- The credential cannot reach another host through this client: loopback only, no redirect, no proxy.

**Bad, or risky**

- Basic authentication over HTTP sends the password in clear text on the loopback interface. Any process on the host
  can read that traffic and the `.env`; the host is the trust boundary, as it is for RCON today.
- The game's own process listens on every interface inside its container. Only Docker's `127.0.0.1` binding keeps the
  port off the public address. A module that publishes the port without the address opens the API to the Internet;
  `server/tests/compose-bindings-test.sh` checks the binding for every HTTP game.
- Some facts about Palworld are from the image, not from Pocketpair's documentation: the `/v1/api` path prefix and the
  user `admin` with the admin password. They are not proven against a running server. If either is wrong, every
  probe is refused and the world never stops by itself; that fails closed.
- The two readings come from two requests. A player who joins between them makes them disagree, and that probe is
  refused. The next probe reads the count again.
- Satisfactory's API is HTTPS with a self-signed certificate (unverified). This client refuses `https`; Satisfactory
  extends it with certificate pinning when it is built.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Palworld's RCON | Deprecated by the game's maker and scheduled to stop working; drops multi-byte characters in names |
| `curl` from the game module | The password would be on the command line, a redirect could carry it off the host unless every call sets the right flags, and `curl` is one more host dependency |
| Call the API from inside the container (`docker exec`) | Ties the probe to the image's tools and user, and makes every probe a container exec |
| Publish the API on the public address behind its password | The game's maker says not to; one leaked password would let anyone stop or change the server |
| Trust `/metrics` alone | One number from code we do not control decides whether to stop a server with people on it |
