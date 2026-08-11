# ADR-0024 — How players reach the server is a pluggable choice, with three supported modes

- Status: Proposed
- Date: 2026-08-11
- Milestone: M2
- Supersedes: [ADR-0017](0017-stable-server-address.md), which picked one approach. Its cost reasoning is
  inherited by mode B below

## Context

[ADR-0017](0017-stable-server-address.md) decided a single answer: a Route 53 hostname, updated on every start.
That decision quietly assumed a purchased domain, and it left the project unable to work without one.

Two things force this open:

1. **A domain may not exist.** Registration is an annual cost, and the project should be playable before anybody
   spends money on a name.
2. **[ADR-0022](0022-minecraft-account-as-linked-identity.md) chose `online-mode=false`.** The Minecraft layer
   therefore provides no protection against impersonation, so *who can reach the port* becomes the security
   boundary rather than a convenience question. That makes connectivity a security decision, and it deserves
   explicit modes rather than one implied default.

The three candidate approaches are a raw public address, public DNS on an owned domain, and an overlay network
such as Tailscale. They differ in cost, in setup friction and — critically — in whether the port is exposed to the
internet at all.

## Decision

Connectivity is **one contract with three implementations**, selected by configuration. The contract is small:

| Step | Responsibility |
| --- | --- |
| On start, publish | Given the running instance, produce the connection string players use |
| On start, verify | The start operation does not reach *ready* until that connection string actually works |
| On stop, retract | Leave nothing pointing at an address that no longer serves this world |
| Report | The surfaces show only the connection string, never a raw address that will expire |

Exactly one mode is active at a time. Modes are not combined: opening a public port *and* running an overlay gives
the weaker of the two postures, not the stronger.

### Mode A — Public address, announced

No domain, no overlay. The start operation reads the instance's public address, and the panel and bots announce it.
Players paste it in each time it changes.

- Cost: only the public IPv4 hourly charge while running.
- Setup: none. Available from M2.
- Port: **open to the internet.**

### Mode B — Public DNS on an owned domain

The design from [ADR-0017](0017-stable-server-address.md), including its reasoning: a short-TTL record rewritten on
start costs nothing while the server is stopped, whereas an Elastic IP is billed all month for an address that is
idle most of it. With several worlds, one hostname per world. See [ADR-0023](0023-multiple-worlds.md).

- Cost: domain registration annually, plus a hosted zone monthly.
- Setup: buy a domain, delegate it.
- Port: **open to the internet.**

### Mode C — Overlay network (Tailscale), no public port

The instance joins a tailnet on boot and is reachable only from member devices. The security group opens **no**
inbound port. Players install the client once, are invited once, and then use a stable overlay name that never
changes — so this mode solves address stability as a side effect rather than as a mechanism.

- Cost: expected to fall inside Tailscale's free personal tier at this scale. **Verify current device and user
  limits and terms before relying on it.**
- Setup: every player installs a client and accepts an invitation.
- Port: **not exposed at all.**

### Which mode to use

**Mode A first, mode C for real play.** Mode A is free and immediate, and it is the right thing during M2 while the
lifecycle is being built. Once people are actually playing a world they care about, mode C is the default, because
it is the only one of the three that supplies the network gate that `online-mode=false` depends on. Mode B is for
when a domain is wanted for its own sake, and it does not remove the need for the gate.

Stated as a rule, because it is the thing to get right: **mode A or B combined with `online-mode=false` means
anybody who learns a whitelisted username can join as that player.** Acceptable for a throwaway test world;
not for a world with months of building in it.

## Consequences

**Good**

- The project works with no domain, no overlay and no spending, which means it can be played before it is finished.
- Choosing the security posture becomes an explicit, reviewable configuration value rather than an accident of
  which tutorial was followed.
- Mode C gives a strictly better posture than the original design: no inbound port at all, so the security group
  stops being the only boundary.
- Mode C makes the address problem disappear, rather than solving it with DNS updates that can fail.
- The contract keeps the choice out of everything else. The surfaces show a connection string and do not care how
  it was produced.

**Bad, or risky**

- Three implementations to write and keep working, of which any given deployment exercises one. The other two rot.
- Mode C puts a third party in the join path. If Tailscale's coordination service is unavailable, a new device
  cannot join even though the server is fine.
- Mode C asks every player to install something. For a non-technical friend, that is real friction and a support
  conversation.
- The instance still needs a public address for its own outbound traffic — Tailscale coordination, S3, SSM — so the
  public IPv4 charge applies while running in every mode. Mode C removes exposure, not that line of the bill.
- A disposable instance must re-authenticate to the tailnet on every start, which means a credential on the host.

**Mitigations**

- Keep modes A and B genuinely thin: read an address, write a record. Almost all the logic lives in the shared
  contract, so there is little to rot.
- Mode C uses an ephemeral, pre-authorised auth key from SSM Parameter Store, so a fresh instance registers itself
  and its node disappears when it goes. Restrict the key's scope, and tag the node so overlay access rules can
  limit which devices may reach the game port.
- Document the fallback: if the overlay is unavailable, the owner can switch modes and restart. It is a
  configuration change, which is the point of the contract.
- The runbook records which mode each world uses, beside the `online-mode` setting, because the two only make sense
  read together.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Elastic IP | Never changes and nothing to update, but billed hourly all month for an address idle most of it. The analysis inherited from [ADR-0017](0017-stable-server-address.md) |
| Security-group allow-list of players' home IP addresses | No client to install and no domain needed, and it does gate the port. Residential addresses change, so it becomes a support task every few weeks, and it fails for anybody on mobile tethering |
| Self-hosted WireGuard instead of Tailscale | Removes the vendor and is not hard to run. It needs a stable endpoint to connect to, which is the problem being solved, plus manual key distribution — so it reintroduces the work Tailscale's coordination service is doing |
| A dynamic DNS provider | Free tiers exist, works, and needs no purchased domain. Adds a third party to do what Route 53 already does inside the account, and it leaves the port exposed. A reasonable substitute for mode B if a domain is never bought |
| A public tunnel service, such as a TCP relay or `playit.gg`-style proxy | No domain, no client for players, stable address. Puts an unaccountable third party in the traffic path of a server with no authentication, and arbitrary TCP through the general-purpose CDN tunnels is usually a paid feature. Verify before considering |
| One mode only, as [ADR-0017](0017-stable-server-address.md) had it | Less code. Forces a domain purchase before first play, and leaves the security posture implicit at exactly the moment `online-mode=false` made it load-bearing |

## Open questions

- Tailscale's current free-tier device and user limits, and whether its terms cover this use. This decides whether
  mode C is free or has a monthly cost.
- Whether overlay access rules should restrict the game port to player devices specifically, or whether tailnet
  membership is a sufficient boundary for a group of friends.
- Whether mode C should also cover administration, letting SSM be replaced by direct access over the overlay.
  Probably not: SSM's audit trail is worth keeping. See [ADR-0007](0007-ssm-instead-of-ssh.md).
- Whether a world may declare its own required mode — for example a public test world in mode A while the main
  world is in mode C. The per-world model in [ADR-0023](0023-multiple-worlds.md) allows it; running two modes at
  once on one instance does not.
