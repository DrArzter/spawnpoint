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

#### Does an address that only exists during a session help?

A fair question, since mode A holds no Elastic IP and the address genuinely disappears when the instance stops. It
helps less than it looks.

**Exposure window, yes.** Roughly 75 hours a month instead of 730, so about a tenth of the time to be found in.

**Findability, no.** Port 25565 is continuously swept across the whole IPv4 space by Minecraft-specific scanners and
general services. A fresh server on the default port is typically found in hours, not weeks, so a changing address is
re-found every session rather than lost.

**And the specific mechanism matters more than either.** The server list ping response includes a *sample of currently
online player names*. In offline mode that turns the one thing standing between a stranger and a whitelisted account —
knowing a valid username — from a barrier into a free lookup. Scan, read the sample, connect as one of them. Verify
whether the server software allows suppressing that sample; vanilla and Forge may not, and Paper-family options do not
apply here.

So the honest statement: an ephemeral address is **obscurity with a short half-life**, not a control.

**The cost consequence is sharper than the security one, and it is the same event.** The idle watchdog stops the
instance when the player count reaches zero, so anybody who joins holds the server open — 730 hours instead of 75. The
running-hours alarm bounds that to small change per incident rather than a month of it. Worked through in
[docs/costs.md](../costs.md).

**One cheap thing does help materially: do not listen on 25565.** Scanners concentrate on the default port, so a random
high port removes the project from the sweep that finds servers by default. It costs players nothing when the
connection string carries the port, and in DNS mode an SRV record hides it entirely. It is still obscurity — but it is
the obscurity that actually reduces contact, where a rotating address is the obscurity that does not.

That makes mode A on a non-default port a reasonable posture for the throwaway M0 world, and still not a substitute for
the overlay once a world has months of building in it.

### Mode B — Public DNS on an owned domain

The design from [ADR-0017](0017-stable-server-address.md), including its reasoning: a short-TTL record rewritten on
start costs nothing while the server is stopped, whereas an Elastic IP is billed all month for an address that is
idle most of it. With several worlds, one hostname per world. See [ADR-0023](0023-multiple-worlds.md).

- Cost: domain registration annually, plus a hosted zone monthly.
- Setup: buy a domain, delegate it.
- Port: **open to the internet.**

### Mode C — Overlay network, no public port

The instance joins an overlay network on boot and is reachable only from member devices. The security group opens
**no** inbound port. Players install a client once, are admitted once, and then use an overlay address that never
changes — so this mode solves address stability as a side effect rather than as a mechanism.

The overlay vendor is a **sub-choice, not part of the mode**. The mode is "membership of a private network is the
gate"; who provides that network is one implementation of the contract, and it is swappable.

**In every implementation the node is persistent, not ephemeral.** The agent's state directory lives on the
persistent EBS data volume that already holds the worlds, so the same node identity returns on every start. The
instance goes offline and online like a laptop being closed, rather than registering as a new device each time.

This corrects an earlier draft, which specified an ephemeral Tailscale node. Ephemeral nodes are meant for CI
runners and Kubernetes pods, and Tailscale meters them at **1,000 ephemeral minutes per month** — about 16 running
hours, against roughly 40 hours a month here. Persistent on-disk state is not ephemeral, so it leaves that meter
entirely, and it is the better design regardless: one stable device instead of a console filling with dead entries,
and an auth key needed once at first registration rather than on every boot.

#### Choosing the overlay

The two candidates bind on **different axes**, and both are free at this scale today. Figures verified 2026-08-11;
see sources.

| | Tailscale Personal | ZeroTier Personal |
| --- | --- | --- |
| Cost | $0 | $0 |
| People | **6 users** | No user limit; 1 network admin |
| Devices | Unlimited user devices | **10 devices** |
| Networks | One tailnet | **1 network** |
| Names for hosts | MagicDNS included | Not on the free tier; connect by overlay IP |
| Layer | L3, IP-level | L2, Ethernet-level |
| Next tier | Per user, per month | Flat monthly, and it still includes only 10 devices |

**Chosen: ZeroTier**, decided 2026-08-12. Two reasons, of which the second is the stronger.

**Which limit binds first.** Tailscale runs out of *people* at six — the owner plus five friends, with no headroom —
and a seventh person is a per-user monthly charge several times the whole AWS bill. ZeroTier runs out of *devices* at
ten, which covers eight or nine players on one PC each. A Minecraft group is far more likely to gain a person than to
double everyone's device count, so the device pool is the more forgiving shape here.

**LAN discovery, which only an L2 overlay can carry.** Because ZeroTier is an Ethernet-level network, it transports
the multicast that Minecraft's LAN discovery uses, so the server can appear in players' "LAN" list with **no address
typed at all**. The owner has observed this working with the `itzg` image, so it is an observation rather than a
hypothesis. That is the nicest possible answer to "how do players connect": the connection string stops mattering to
players entirely.

Tailscale operates at L3 and therefore **cannot** do this, whatever else it offers. If LAN discovery is wanted, the
choice is settled independently of pricing.

Tailscale wins if people have several machines each, and it gives host names on the free tier, which mode C would
otherwise lack. Neither choice is locked in: it is one implementation of the connectivity contract.

One thing still to pin down: **which component does the announcing.** The owner's test was Java Edition over
ZeroTier, so the multicast path across the overlay is confirmed. What is not confirmed is the source of the
broadcast:

- A vanilla Java dedicated server does not announce itself. That multicast comes from a *client* opening a
  single-player world to LAN.
- The `itzg` image is **not** the source either. Its repository contains no reference to the LAN discovery protocol —
  no port `4445`, no `224.0.2.60`, no multicast handling. Its only "broadcast" options are the unrelated
  `broadcast-console-to-ops` and `broadcast-rcon-to-ops` server properties. Checked 2026-08-11.

So the announcement came from the pack or from the wider setup — most plausibly a mod that advertises a dedicated
server to the LAN. That is good news rather than bad: a mod is something this project already controls, because every
mod is declared in a release manifest. See [ADR-0008](0008-versioned-mod-releases.md).

**Therefore: identify it, then make it a required entry in every release definition** rather than a happy accident of
one pack. If no such mod turns out to be present, the remaining explanation is that the entry was in the players'
server list rather than in the LAN section, and the feature has to be built by adding a broadcaster deliberately —
still cheap, and still worth it.

Note also the correction to a common recollection: ZeroTier's free tier **does** limit devices. It is 10, alongside
1 network. Older versions of that plan were far more generous on device count, which is where the "networks are
limited, devices are not" impression comes from.

- Cost: $0 on either, within the limits above.
- Setup: every player installs a client and is admitted once — by invitation in Tailscale, or by the owner approving
  their node in ZeroTier.
- Port: **not exposed at all.**
- Ceiling: six *people* on Tailscale, ten *devices* on ZeroTier. See the risks below.

### While the server still runs on the owner's machine

Worth separating, because the answer differs from the cloud answer and the project is in this phase today.

With the server on a desktop, **Porthole is the better tool than an overlay**: nothing to install and configure beyond
one Steam app, a guest joins with a share code, and only the game port is shared rather than putting five machines on a
common network. It also satisfies what `online-mode=false` needs — there is no public port, and only somebody holding
the code can reach it. See [ADR-0022](0022-minecraft-account-as-linked-identity.md).

It does not survive the move to EC2, for the reason in the alternatives table. That is not a problem: connectivity is a
pluggable contract precisely so that the local phase and the cloud phase can differ. Using it now costs nothing later,
provided nothing else is built to assume it.

And if it turns out to be so much better than the alternatives that the group does not want to give it up, that is an
argument about **where the server lives**, not about making Porthole headless. Keeping the server on a machine that
already runs Steam is a coherent position — it simply is not this project, which exists to put the server somewhere the
owner does not have to leave switched on.

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
- **Mode C has a free-tier cliff, and where it sits depends on the vendor.** Tailscale: the seventh *person*.
  ZeroTier: the eleventh *device*. Either cliff lands well above the entire AWS bill in
  [docs/costs.md](../costs.md), so growing the group is a pricing decision rather than a configuration change, and
  it needs deciding before somebody is promised access.
- Whether a player given the server as a *shared device* counts towards Tailscale's user limit — which would move
  that cliff — is unresolved. See the open questions.
- On ZeroTier's free tier there are no host names, so players connect by overlay IP. Stable, and less pleasant;
  it also means the per-world names in [ADR-0023](0023-multiple-worlds.md) fall back to the surfaces stating which
  world is running. LAN discovery makes this largely moot for players, and not for the automation, which still needs
  an address to health-check.
- The LAN-discovery advantage depends on a component that has not yet been identified, so it is a strong reason to
  prefer ZeroTier and not yet a guarantee. Treat the typed address as the supported path until the broadcaster is
  pinned down.
- The node identity now depends on the data volume. Losing that volume means re-admitting the node, which is a minor
  extra step during a restore.
- Tailscale states it is not currently enforcing hard limits or overages on these allowances, and intends to
  introduce enforcement with notice. Building on non-enforcement would be building on sand.

**Mitigations**

- Keep modes A and B genuinely thin: read an address, write a record. Almost all the logic lives in the shared
  contract, so there is little to rot.
- Mode C keeps its node state on the data volume, so the node is persistent, outside any ephemeral meter, and needs
  its credential only once. Where the vendor supports it, tag the node so access rules can limit which devices may
  reach the game port, and disable key expiry so a stopped server does not need re-authorising after a quiet
  fortnight.
- Track the count that matters for the chosen vendor — people for Tailscale, devices for ZeroTier — and record it in
  the runbook. Decide what happens at the cliff before it arrives.
- Both vendors have a self-hosted control-plane option, which removes the third party from the join path if that
  dependency ever becomes unacceptable. Verify the current state of either before relying on it.
- Document the fallback: if the overlay is unavailable, the owner can switch modes and restart. It is a
  configuration change, which is the point of the contract.
- The runbook records which mode each world uses, beside the `online-mode` setting, because the two only make sense
  read together.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Elastic IP | Never changes and nothing to update, but billed hourly all month for an address idle most of it. The analysis inherited from [ADR-0017](0017-stable-server-address.md) |
| Security-group allow-list of players' home IP addresses | No client to install and no domain needed, and it does gate the port. Residential addresses change, so it becomes a support task every few weeks, and it fails for anybody on mobile tethering |
| Self-hosted WireGuard instead of a managed overlay | Removes the vendor, has no per-user or per-device pricing, and is not hard to run. It needs a stable endpoint to connect to, which is the problem being solved, plus manual key distribution — so it reintroduces the work a coordination service does. **Becomes the serious alternative at whichever free-tier cliff arrives first**, and it is what a self-hosted overlay controller is a gentler version of |
| **Porthole**, sharing the game port over Steam's relay | Free, and the lowest friction of anything considered: a guest joins with a share code, approves one port, and needs no client configuration or admin approval. It shares only the chosen port rather than putting whole machines on a network, which is a better security shape than an overlay. **Disqualified for the cloud phase by its host requirement** — it is a Steam desktop application running over Valve's networking, so the host needs a logged-in Steam client. Our host is a headless, disposable EC2 instance created and destroyed per session by [ADR-0027](0027-spot-request-shape.md), and a desktop client has no place in that lifecycle. Verify before dismissing entirely, but the expectation is firm. It is also days old, which is thin ice for infrastructure. **Genuinely good for the phase the project is in right now**, where the server runs on the owner's own machine — see below |
| A dynamic DNS provider | Free tiers exist, works, and needs no purchased domain. Adds a third party to do what Route 53 already does inside the account, and it leaves the port exposed. A reasonable substitute for mode B if a domain is never bought |
| A public tunnel service, such as a TCP relay or `playit.gg`-style proxy | No domain, no client for players, stable address. Puts an unaccountable third party in the traffic path of a server with no authentication, and arbitrary TCP through the general-purpose CDN tunnels is usually a paid feature. Verify before considering |
| One mode only, as [ADR-0017](0017-stable-server-address.md) had it | Less code. Forces a domain purchase before first play, and leaves the security posture implicit at exactly the moment `online-mode=false` made it load-bearing |

## Open questions

Answered on 2026-08-11, see sources below:

- ~~Tailscale's free-tier limits.~~ Personal: $0, up to 6 users, unlimited user devices, 3 ACL groups, 50 tagged
  resources, 1,000 ephemeral minutes per month.
- ~~ZeroTier's free-tier limits, and whether devices are unlimited.~~ Personal: $0, **10 devices**, 1 network, 1
  network admin. Devices are limited; the impression that they are not comes from an older version of that plan.
- ~~Whether the ephemeral-minute allowance constrains this design.~~ Not any more: the node is persistent, and
  persistent on-disk state is not ephemeral. It would have been tight otherwise — and note that an ephemeral node
  running four hours or more is reclassified as a standard tagged device and stops consuming minutes, so long
  evenings would have escaped the meter while short ones burned it.

Still open:

- **Whether a player who is given access as a shared device counts towards the 6-user limit.** This decides whether
  mode C scales past six people for free. Tailscale's pricing page does not say; ask them before promising a seventh
  person access.
- Whether overlay access rules should restrict the game port to player devices specifically, or whether network
  membership is a sufficient boundary for a group of friends.
- **Which component broadcasts the server's LAN presence.** Narrowed, not answered: Java over ZeroTier is confirmed
  working by the owner, and the `itzg` image is confirmed not to be the source. The likely answer is a mod in the
  pack, in which case it becomes a declared entry in every release manifest. The distinguishing test costs a few
  minutes: on a client with an empty server list, over the overlay, does the server appear under the local-network
  scan without anything being added by hand?
- Whether ZeroTier's per-network multicast limit needs raising for this, and whether the discovery still works when
  the overlay spans several physical networks rather than one.
- Whether the connectivity contract's "publish" step can be a no-op for players in this mode, with the connection
  string kept only as a fallback for anybody whose client does not see the broadcast.
- Whether mode C should also cover administration, letting SSM be replaced by direct access over the overlay.
  Probably not: SSM's audit trail is worth keeping. See [ADR-0007](0007-ssm-instead-of-ssh.md).
- Whether a world may declare its own required mode — for example a public test world in mode A while the main
  world is in mode C. The per-world model in [ADR-0023](0023-multiple-worlds.md) allows it; running two modes at
  once on one instance does not.

## Sources

Verified 2026-08-11. Tailscale states enforcement of these allowances is not yet active and will arrive with notice,
so re-check before relying on any of it.

- Tailscale ephemeral nodes, and the four-hour reclassification: <https://tailscale.com/kb/1111/ephemeral-nodes>
- Tailscale Personal tier allowances: <https://tailscale.com/pricing>
- ZeroTier plan limits: <https://www.zerotier.com/pricing/>
