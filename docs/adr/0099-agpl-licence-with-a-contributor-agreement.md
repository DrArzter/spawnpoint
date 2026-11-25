# ADR-0099 — AGPL-3.0, with a contributor licence agreement

- Status: Accepted
- Date: 2026-11-25
- Milestone: M6

## Context

The repository is public and had no licence, so nobody could lawfully use, change or fork it. The owner wants
people to read it, run it, change it and contribute to it, and does not want a hosting business to take it and sell it
as a service. The owner also wants to keep the option of a commercial licence or a sale later.

A licence that forbids commercial use is not open source, so it rules out open-source programmes such as AWS Open
Source Credits and puts off many contributors.

## Decision

1. **The code is licensed under AGPL-3.0** ([`LICENSE`](../../LICENSE)). Anyone may use, change and share it, also
   commercially. Whoever runs a changed version as a network service must offer its source to that service's users
   (section 13). A host that sells a closed fork cannot do so.
2. **Contributions come under a contributor licence agreement** ([`CONTRIBUTING.md`](../../CONTRIBUTING.md)). A
   contributor keeps the copyright and grants the owner a licence wide enough to relicense the project, for example
   to offer a commercial licence beside AGPL-3.0.
3. **The games stay their own.** A game server Spawnpoint starts is a separate program under its own terms. The game
   modules under `server/games/` are part of Spawnpoint and under AGPL-3.0.

## Alternatives

| Option | Why not |
| --- | --- |
| MIT or Apache-2.0 | Open source with no condition: a host may sell a closed fork |
| PolyForm Noncommercial, Business Source Licence or Elastic Licence 2.0 | Forbid the hosting case directly, but none is open source |
| AGPL-3.0 without an agreement | Each contributor's code stays under AGPL-3.0 only, so the project could never be relicensed |

## Consequences

- The project is open source and may apply for open-source credit programmes.
- Some companies do not allow AGPL-3.0 code inside; that audience is not this project's audience today.
- A contributor signs the agreement once. Before any commercial licence or sale, have a lawyer review the licence and
  the agreement.
- Not legal advice: the agreement follows the common Apache-style grant and was not drafted by a lawyer.
