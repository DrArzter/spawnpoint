# ADR-0085 — A persistent host serves public worlds too

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Amends: [ADR-0033](0033-connectivity-as-a-strategy.md) (its 2026-09-22 revision kept the persistent host on
  ZeroTier), [ADR-0007](0007-ssm-instead-of-ssh.md) (the persistent host's security group)

## Context

A world on a fleet host is reached by its public address or by a DNS name. A world on the persistent host could
only use ZeroTier. Nothing in the connectivity adapters required that. Two things did:

- The persistent host's security group opened a game port only for a world declared public in the host catalog,
  through Terraform. A world created in the panel could not open one.
- Every game port was published on every address of the host. The closed security group was the only thing that kept
  a ZeroTier world, whose gate is the overlay, off the internet. Opening a port would have exposed it.

## Decision

1. **A ZeroTier world listens only on the overlay.** At start, the host publishes the game ports of a ZeroTier world on
   its ZeroTier address alone (`SPAWNPOINT_GAME_BIND`). A ZeroTier world with no overlay address does not start. A
   public world (`raw` or `route53`) publishes on every address.
2. **The persistent host opens its game ports like a fleet host.** Its security group opens each game module's own
   port and the slot port range (ADR-0054), for the protocols the games use. RCON stays on loopback. A test fails
   when a game publishes a port on any other address than loopback or the session's bind address.
3. **Any world may choose any connection on any host.** The panel and the API accept `raw` and `route53` on the
   persistent host. A public world still declares the game's own login (`auth: game`), as ADR-0033 requires.
4. **The start document carries the deployment's DNS settings.** The persistent host's environment is not written
   by Terraform, so the `spawnpoint-start-session` and `spawnpoint-stop-session` documents (ADR-0082) export the DNS
   zone, suffix and ledger table, and the host reads its instance id from instance metadata.
5. **ZeroTier stays off fleet hosts** (ADR-0033), unchanged.

## Consequences

- A public world can run on the persistent host, with its address or its DNS name.
- A port that is open is not by itself an exposure: what listens on it is decided per session by its connection.
- A game module that publishes a port carelessly fails the binding test instead of reaching the internet.
