# ADR-0017 — Give the server a stable hostname in Route 53, not an Elastic IP

- Status: Proposed
- Date: 2026-08-11
- Milestone: M2

## Context

A stopped and restarted EC2 instance gets a new public IPv4 address. So does a replacement instance after a
Spot interruption. Since this design stops the server after every session, the address changes constantly,
and players cannot keep a working entry in their server list.

Two ways to fix it. Attach an Elastic IP, which never changes; or update a DNS record when the instance boots.

AWS charges for all public IPv4 addresses by the hour, whether they are Elastic IPs or the automatically
assigned address on a running instance. The rate is small — in the region of half a cent per hour, so a few
US dollars a month for one address held continuously; verify the current figure against the EC2 pricing page.
The difference between the options is therefore not whether the address is billed, but whether it is billed
while the server is stopped, which is most of the month.

A hosted zone in Route 53 has its own small monthly charge, plus a per-query charge that is negligible at this
volume.

## Decision

Register a DNS record, and update it from the instance on every boot. On start, the instance reads its own
public address and writes it into a short-TTL A record; the control plane reports the hostname, never the
address. Players use the hostname only.

The record is a Minecraft-friendly hostname. If a non-default port is ever used, an SRV record removes the
need for players to type it.

## Consequences

**Good**

- Nothing is billed for an address while the server is stopped, which is most of the time. That matters
  precisely because the design's whole point is being stopped.
- Players keep one entry in their server list forever, including across an instance replacement.
- The mechanism also survives a change of instance type, availability zone or region.
- A short TTL means a Spot replacement is reachable again within a minute of coming up.

**Bad, or risky**

- The DNS update is a step that can fail, and when it fails the server is up but unreachable by name — a
  confusing failure to diagnose.
- A short TTL means slightly more queries, and a client or resolver that ignores the TTL will cache a stale
  address.
- The instance needs permission to change a DNS record, which is a wider permission than it otherwise needs.
- A hosted zone costs a small amount every month, whether or not anybody plays.

**Mitigations**

- The DNS update is part of the start operation, and the operation does not reach *ready* until the record
  resolves to the new address. See [ADR-0012](0012-web-control-panel.md).
- Scope the instance's permission to exactly one record in one hosted zone, and nothing else.
- The control panel and the bots always show the hostname, so nobody circulates a raw address that will expire.
- If DNS proves unreliable in practice, an Elastic IP is a small, well-understood monthly cost and a one-line
  change.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Elastic IP | Never changes, nothing to update, no failure path. Billed by the hour even while the server is stopped, which is the majority of the month, and it buys nothing the DNS update does not |
| No stable address; post the current IP in chat each time | Free, and the M0 behaviour. Every player re-adds the server every session |
| A dynamic DNS provider | Free tiers exist and it works, but it adds a third-party dependency for something Route 53 already does inside the account |
| Route 53 query logging as both the address source and the wake trigger, as in the prior art | Clever, and it solves two problems at once. Requires the trigger Lambda in `us-east-1` and an anonymous wake, which [ADR-0006](0006-on-demand-start-and-idle-shutdown.md) rejected for lack of attribution |
| IPv6 only | Free addresses, and stable per interface. Rejected because too many players are on networks without working IPv6 |

## Open questions

- Which domain to use, and whether one is already owned. Registration is an annual cost either way.
- Whether the update is made by the instance itself, or by the start Lambda after the instance reports ready.
  The Lambda is the safer place, since the permission then does not sit on an internet-facing host — a
  correction worth making before implementation.
