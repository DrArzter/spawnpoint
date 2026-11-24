# ADR-0086 — A stopped world's DNS name points at a parked address

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Amends: [ADR-0033](0033-connectivity-as-a-strategy.md) (the Route 53 adapter retracts a world's record at stop)

## Context

A world with a DNS connection publishes `<world>.<suffix>` as an A record when its session starts, and deleted the
record when it stopped. Between sessions the name did not exist. A player whose game looked the name up in that time,
or during the minutes of a start, got "no such name". Resolvers cache that answer for `min(SOA TTL, SOA minimum)`.
On a Route 53 zone that is 15 minutes. So after a start had published the new address, players still could not
connect for up to 15 minutes. On 24 November 2026 the record was written at 01:15:15 and the session was stopped at
01:25 because nobody could connect.

## Decision

1. **A stop parks the name.** In one Route 53 change batch, the host deletes the exact address it published and creates
   the same name at `192.0.2.1` (TEST-NET-1, RFC 5737: reserved and routed nowhere), with the same 30-second TTL.
   - If a newer session has already replaced the address, the delete fails and so does the whole batch, so a newer
     address is never erased.
   - The terminal-host reconciler parks a dead host's names the same way.
2. **A start publishes over the parked address** (UPSERT), as before. A cached parked answer lasts 30 seconds, so the
   new address is seen within half a minute.
3. **The zone caches a missing name for a minute.** The SOA minimum is 60 seconds, so a name looked up before its first
   start is not stuck as missing for 15 minutes.
4. The host role and the reconciler's role may `CREATE` an A record under the suffix, in addition to their existing
   actions.

## Consequences

- A world's name always answers. While the world is stopped it answers an address that nothing listens on, so a game
  reports that it cannot connect instead of that the name does not exist.
- A name is never left pointing at an address AWS may give to someone else's machine.
