# ADR-0063 — Run console commands through one SSM document, recorded per identity

- Status: Accepted
- Date: 2026-10-09
- Milestone: M4
- Relates: [ADR-0007](0007-ssm-instead-of-ssh.md), [ADR-0034](0034-per-game-adapter.md),
  [ADR-0036](0036-observed-visitors-and-owner-approved-access.md), [ADR-0062](0062-give-each-fleet-world-a-session-record-of-its-own.md)

## Context

Both faces of the panel have drawn an RCON console since the first redesign, with its input disabled and a line
saying the gateway was not connected. Every game module already speaks RCON on the host: Minecraft through `rcon-cli`
inside its container, Factorio and Project Zomboid through a small Source RCON client against the slot's host port.
The roles already carry `console.use`, "Run RCON commands, recorded against your identity". What was missing was a way
from a person in the browser to that function on a host, and a record of who used it.

Three constraints shaped it. The API Lambda answers within ten seconds, and a host command through SSM takes one to a
few. The API must not gain a general shell on the game hosts: the generic `AWS-RunShellScript` would let a bug in the
API, or anyone who controlled it, run anything as root. And a console is a way around the lifecycle: `stop` typed into
Minecraft ends the server without the verified backup, and leaves the lifecycle record saying the session still runs.

## Decision

**One SSM document, `spawnpoint-console`, runs one script, `server/scripts/console.sh`, and nothing else.** Its three
parameters are held to patterns that admit no quote, space or shell metacharacter: the world id, the slot (digits or
empty), and the command as base64. The API role may send that document only, to the configured host and to hosts that
carry the fleet tag, and read invocation results. No shell between the API and the game ever reads the command as
code: the script decodes it, holds it to one printable line, and hands it to the game's new `game_console` function as
a single argument.

**A command is sent and recorded at once, and its answer collected when the history is next read.** `POST
/games/{gameId}/worlds/{worldId}/console` checks the command, finds the world's ready session (ADR-0062) and the host
and slot it holds, sends the document, writes a record to the access table and answers `202`. `GET` on the same path
returns the world's last thirty records and settles any still pending from SSM. The panel reads it again every second
and a half while a command waits, and every five seconds otherwise. No request waits on a host.

**Every command is recorded against who ran it**: the identity and its display name, the world, the session, the
host, the command, the status and up to 4,000 characters of the answer. Records expire after ninety days. Anyone who
may use the console can read a world's history; it is how operators see what each other did.

**Commands that end the game outside its lifecycle are refused**: `stop` and `save-off` for Minecraft, `quit` for
Factorio and Project Zomboid. Stop is a verb of the world page, which saves, verifies a backup and closes the session.

**The console speaks to one running world at a time.** With several worlds of a game running, the operator picks
which. A world that is not running has no console.

## Consequences

- The console works on both faces and in the demo, and the `consoleGateway` capability now deploys, so the page appears
  in production for roles with `console.use`.
- The configured host runs whatever copy of the repository it has. Until that copy carries `console.sh`, the document
  answers that the host has no console script yet, and the panel shows it. A fleet host checks out the deployed commit
  when it launches, so it always has the script.
- The API role gains `ssm:SendCommand` for one document on Spawnpoint's hosts, `ssm:GetCommandInvocation`, and
  `dynamodb:Scan` on the lifecycle table to find a session's host and slot. Its reads of that table already covered every
  item; the scan reads the host records it could already get one by one.
- Factorio's and Zomboid's RCON port is now read when a command is sent rather than when the module loads, so a session
  on a slot other than zero reaches its own port. Probes always had this fault; no session ran on such a slot yet.
- The MCP tools do not offer the console. An agent with a console needs the narrower confirmation contract the MCP
  README already asks for before it gets restore, wipe or purge.

## Alternatives

| Option | Why not |
| --- | --- |
| `AWS-RunShellScript` with the command in the script | Gives the API a root shell on every game host; the safety would rest on escaping in TypeScript |
| A daemon on each host, reached over the network | A process that runs when nobody plays, an open port, and a credential to manage; ADR-0007 chose SSM so the host has no inbound path |
| Wait for the answer inside the request | Ten seconds is not enough margin for SSM on a busy host; a slow answer would read as a failure |
| An allow-list of commands | Operators use the console for the commands nobody listed; the refusal list names only what breaks the lifecycle |
