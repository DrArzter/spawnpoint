# ADR-0033 — Connectivity is a strategy behind one interface, constrained by the game's auth model

- Status: Accepted — 2026-09-22. ZeroTier, raw IP and Route 53 are separate host adapters, and the gate-versus-auth
  invariant is enforced by the host's catalog validator and by a `check` block in `infra/terraform`
- Date: 2026-08-14
- Revised: 2026-08-27 — the invariant gained its operator override: it refuses the silent combination, never a
  declared one
- Revised: 2026-09-22 — a world's adapter is independent of placement. The disposable fleet enables public
  adapters only. ZeroTier stays with persistent hosts: deleting a fleet host's identity would require authorising
  every replacement and cleaning its predecessor. A future ephemeral-friendly overlay needs its own adapter and
  membership policy. No provider is mandatory for a self-hosted deployment.
- Milestone: M2, and the multi-game part later
- Amends: [ADR-0024](0024-connectivity-modes.md) — keeps its decision that **this project uses ZeroTier**, and turns
  its "one contract, three modes" from a choice made once into an actual interface with an invariant
- Relates: [ADR-0022](0022-minecraft-account-as-linked-identity.md) (`online-mode=false` is why a gate is needed),
  [ADR-0007](0007-ssm-instead-of-ssh.md), [ADR-0031](0031-first-class-local-control-plane.md) (the adapter boundary),
  and the per-game adapter recorded as a placeholder in [the index](README.md#decisions-still-to-record)

## Context

[ADR-0024](0024-connectivity-modes.md) already called connectivity "a pluggable choice, with three supported modes",
but in practice the mode is chosen once for the whole repository — mode C, ZeroTier. Two things push that from a
one-time choice toward a real interface.

**Connectivity is not independent of the game.** With `online-mode=false` ([ADR-0022](0022-minecraft-account-as-linked-identity.md))
Minecraft authenticates nobody, so *who can reach the port* is the access boundary, and only an overlay supplies it. A
game that authenticates its own players needs no such gate, and there a public address or a DNS name is fine and
cheaper to onboard. So the correct connectivity is a function of the game's auth model, not a global preference.

That model is a property of the *server*, not of the game's name — which is why the default has to fail closed.
Factorio is the instructive case: its identity verification runs only on a server that is visible in the matchmaking
list and holds factorio.com credentials, and the hidden server this project runs deliberately holds none. The same
fact that frees the server from needing an account also means it verifies nobody, so a hidden Factorio world is as
gate-dependent as offline-mode Minecraft, and the operator who runs the visible, credentialed variant says so
explicitly.

**One combination is unsafe and should be impossible by accident.** A no-auth game reached over a non-gating
connectivity is an open server. An operator may still choose that deliberately — with authentication supplied outside
the game's defaults, or with eyes open — but today the line between "chose" and "forgot" is only prose spread across
[ADR-0022](0022-minecraft-account-as-linked-identity.md) and [ADR-0024](0024-connectivity-modes.md). It should be an
invariant checked at the seam, not a thing a future edit can quietly violate.

## Decision

**Connectivity is a strategy behind one interface.** The start and stop lifecycle, the "announce the address" step and
the readiness check depend only on the interface, never on which strategy is active.

**The address is the host's answer, carried back — never an input echoed as a result.** `publish()` runs on the host at
session start, and the host's session summary is the one place the address is born; the start machine parses that
summary and carries `connectionAddress`, `connectionHost` and `connectivity` to whoever asked. Nothing configures or
stores a full address: the overlay strategy's host part is configuration, a public strategy's host part is read from
the instance each session, and the game supplies the port in both cases. This is forced by the raw strategy — a
public address does not exist before the instance starts, so no caller can supply it — and it also removes the
class of bug where a configured string carried one game's port for every game.

The interface is small:

```
ConnectivityStrategy:
  publish(host)    -> address    # make the host reachable; return what a player types
  retract(host)                  # clean up on stop, if the strategy needs it
  reachable(addr)  -> bool       # "ready" means the address actually answers, not just the container
  is_gate: bool                  # does the strategy itself restrict who can connect
  config { ..., secret_ref? }    # e.g. a hosted-zone id, or an overlay network id plus a Parameter Store name
```

Concrete strategies:

| Strategy | `is_gate` | Cost / setup | Notes |
| --- | --- | --- | --- |
| Raw public IP | No | Free, none | The ephemeral public IPv4 the instance already gets on start. Address changes every session. Good for a throwaway or a preview |
| Route 53 | No | A hosted zone plus a registered domain — a real annual cost | Upsert an A record to the current public IP through the AWS API, in-account and keyless. Uniquely **re-enables the implicit DNS-wake trigger** the overlay removed. See [ADR-0006](0006-on-demand-start-and-idle-shutdown.md) |
| Overlay | **Yes** | Free tier, plus per-device onboarding | The host joins a user-provided overlay network. Identity persisted on the data volume so the address is stable across sessions — already done for ZeroTier |

**A valid overlay needs a headless client and a credential-based, non-interactive join** — ideally an API or an auth
key, so a fresh host joins unattended and membership is managed without a human clicking in a console. Tailscale (a
pre-authorised auth key) and ZeroTier (a network id plus the Central API token, or a one-time manual authorise) meet
this cleanly.

The two often named alongside them do not, and for different reasons:

- **Hamachi** *does* ship a headless Linux daemon (`logmein-hamachi`, driven by the `hamachi` CLI), so it can join a
  network from a script — an earlier draft of this ADR was wrong to say it could not. It is still not the pick:
  membership is managed through the LogMeIn web account with no clean API, the free network caps at five members, and
  the Linux client has been neglected for years. Possible, not recommended.
- **Radmin VPN** is genuinely out: Windows-only, no Linux or headless client at all — the same reason Porthole was
  disqualified in [ADR-0024](0024-connectivity-modes.md), with no place on a headless, disposable host.

**The invariant, enforced at the seam rather than in prose:**

```
auth = world.auth if declared else game.default_auth   # data, like `game` and `host`
if auth == none and not strategy.is_gate:
    refuse to start                                    # only the silent combination refuses
```

So offline-mode Minecraft runs behind a gating strategy **by default**, and a self-authenticating game may use any.
This is the prose of [ADR-0022](0022-minecraft-account-as-linked-identity.md) turned into a rule that cannot be
violated *by accident*.

**The override is part of the invariant, not an exception to it.** The control plane cannot actually know a world's
effective auth model: it is server configuration and mods, not the game id. `online-mode=true` is one settings line,
and a whole family of login-wall mods and plugins exists precisely to put real authentication in front of servers
that ship none. An operator who wants a public world and has auth covered is stating a fact the system cannot see
from outside the container, so the system takes the declaration: a per-world `auth: external` in the catalog
publishes the world on any strategy, and the refusal fires only when the combination is *silent*. The invariant's job
is to make the risky pairing explicit and attributable, never to forbid a configuration the operator chose — the same
reason `game` and `host` are catalog data: situations differ, and the code must handle all of them rather than the
one this project happens to run.

### The address is composed: the strategy answers the host, the game answers the port

Added 2026-08-31, when a second and third game made the old shape wrong in production. `publish()` returns "what a
player types", and that string has two owners: the **host part** belongs to the strategy (an overlay address, an
ephemeral public IP, a DNS name) and the **port** belongs to the game (25565, 34197/udp, 16261/udp). Spawnpoint had
one configured string, `172.29.23.24:25565`, returned by the panel, the bot and the start workflow for every world —
so a Factorio session would have handed players Minecraft's port.

So the game module declares `GAME_CONNECT_PORT`, the deployment configures only the host part, and every surface
composes: the host does it in `start-session.sh`, the API in the control-plane read model, the bot for the world it
operates, and the workstation scripts by reading the same catalog the host reads. An address is therefore never
stored anywhere; it is derived, which is what makes a second strategy a change of one value rather than a hunt
through configuration.

One consequence worth naming: the port is not withheld from anyone, but the host part is. A visitor who may not read
the connection gets `null`, not a partial address.

### What a non-gating strategy exposes, and what already answers it

A public game port is found by mass scanners within hours — that is background radiation, not a targeted attack. Worth
recording what that traffic can and cannot do, because the mitigations are not new work; they are existing decisions
doing double duty:

| Threat at a public port | What answers it |
| --- | --- |
| Join attempts by strangers | Authentication — the game's own, or the declared equivalent (an auth mod, `online-mode=true`), which is exactly what the invariant above demands before a non-gating strategy publishes |
| Automated exploitation of a known server vulnerability, typically ending in a crypto miner | The real risk, and Minecraft has lived it (Log4Shell). Blast radius, not prevention: the security group opens the game port and nothing else; the server runs in a container; **IMDSv2 with `hop_limit=1` means a compromised container cannot reach the instance role's credentials**; and the role could not launch instances anyway, so the account cannot be turned into a mining fleet |
| A miner squatting on the host itself | The idle stop is keyed to **player count**, not CPU — `stop-session.sh` refuses to stop only while players are online, so a busy-but-empty host is stopped at the next idle check. The running-hours alarm and the budget are the backstops behind that |
| Running a known-vulnerable version for months | Patch currency is [ADR-0028](0028-update-proposals.md)'s job: updates arrive as proposals instead of never |

**A reverse proxy is deliberately not on that list.** nginx in front of a game port authenticates nobody and games do
not speak HTTP — it would only relocate the open port and add a process to maintain. Name-based routing needs a
protocol that carries a name: HTTP does, TLS does via SNI, the Minecraft handshake does but only game-aware proxies
(Velocity, BungeeCord) read it, and the UDP games carry none — so consolidating *game* traffic is ports or a game
proxy, never nginx. Protection for a public game port is the game's auth plus blast-radius work, not middleware.

There is one honest consolidation case, and it is not security: the host serves Grafana over HTTP inside the overlay,
and the panel is static behind CloudFront — so today there is exactly one thing a proxy could front, for a handful of
people, on a transport the overlay already encrypts. Not worth a component. If a **second** host-side HTTP service
appears — a live map is the likely one — a session-scoped proxy joining the Compose session becomes reasonable
quality-of-life, living and dying with the session like everything else. When that day comes, the leaning is
**Traefik**, precisely because its Docker provider builds routes from container labels: services that appear and
disappear with the session declare their own routing, with no config file to keep in sync. Caddy is the simpler
runner-up; a hand-maintained nginx config for a set of containers that changes per game is the wrong shape.

**Secrets stay in the operator's own account.** A Tailscale auth key or a ZeroTier API token lives in that operator's
SSM Parameter Store, referenced by name — never in the repository or in Terraform state. The automation reads it from
the operator's account; nobody else holds it. Consistent with [ADR-0031](0031-first-class-local-control-plane.md) and
the account-owns-its-secrets rule in [docs/architecture.md](../architecture.md#security-posture).

**ZeroTier stays the one implemented strategy** and the default for this project's offline-mode world;
[ADR-0024](0024-connectivity-modes.md) is unchanged on that point. The others are named now so the interface is shaped
correctly, and each is built only when a second game or a zero-setup onboarding actually needs it.

## Consequences

**Good**

- The lifecycle stops knowing about DNS or overlays. Adding a connectivity option becomes a new adapter, not edits
  scattered across the start flow.
- The unsafe combination cannot happen silently: it either refuses the start or carries the operator's explicit
  per-world declaration.
- Onboarding cost becomes an explicit property of the chosen strategy — raw IP costs nothing, an overlay costs a
  per-device step and a third-party account, DNS costs a domain — so the operator picks the trade knowingly.
- It reopens the implicit DNS-wake of [ADR-0006](0006-on-demand-start-and-idle-shutdown.md) as a per-strategy
  capability rather than a permanently lost one.

**Bad, or risky**

- An interface earns its keep only with more than one implementation, and today there is one. This is abstraction
  slightly ahead of need — accepted because the invariant and the framing have value now, but the extra strategies
  must not be built speculatively.
- The overlay branch depends on a third-party SaaS outside the operator's AWS account, which is the one crack in
  "everything lives in your own account".
- Bring-your-own-overlay means handling an operator secret; a leaked key admits a stranger to their network. Prefer
  ephemeral, pre-authorised keys, and scope them in Parameter Store.
- `reachable()` over an overlay cannot be probed from AWS, because the prober is not on the network. Readiness for
  overlay strategies is host-side, and the interface must allow that.

**Mitigations**

- Build only the strategy in use. Add raw IP when a preview needs it; Route 53 and Tailscale when a second game or a
  zero-setup onboarding actually arrives. The interface is cheap; the implementations are not, and must earn their place.
- Keep identity-on-the-volume for any overlay, so the published address survives an instance rebuild.
- Encode the gate-versus-auth invariant as a validation that fails the start, and cover both branches with tests:
  the silent combination refuses, the declared one publishes.
- The declaration is a catalog field, so it is reviewed and versioned like any other world change — an open server is
  a diff someone wrote, never a default someone forgot.

## Status of the strategies

| Strategy | State | Since |
| --- | --- | --- |
| ZeroTier overlay | Implemented; the default for every catalog world | ADR-0024 |
| Raw public IP | Implemented: security-group ingress derived from the catalog, IMDSv2 address read at session start, address composed per world in the panel and the bot, nothing between sessions | 2026-09-03 |
| Route 53 | Implemented as a session-scoped A record: publish after game readiness, retract after verified stop and backup, restricted IAM permission on an optional hosted zone | 2026-09-22 |
| Tailscale, bring-your-own | Not started | — |

Turning a public strategy on for a world is two catalog fields, `connectivity: raw` or `route53` and a declared `auth`, and the
runbook records the rollout order.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep "choose one mode per repository", as [ADR-0024](0024-connectivity-modes.md) reads today | Simplest, and fine while there is one game and one deployment. Breaks the moment connectivity must differ by game, and leaves the unsafe combination as prose |
| Hard-wire ZeroTier only | Least code. Ties the project to one SaaS and one game's auth model, and blocks both the multi-game and the zero-setup-onboarding directions |
| A hosted broker that manages connectivity for users | Would enable true one-click onboarding, but reintroduces an always-on service and makes the author hold users' network credentials — the operator/SaaS line deliberately not crossed |

## Open questions

- Whether `reachable()` for an overlay strategy is a host-side self-report or an out-of-band check from another member
  of the network.
- Whether the Route 53 strategy should also restore the implicit DNS-wake, or keep the explicit, attributed trigger for
  the reasons in [ADR-0006](0006-on-demand-start-and-idle-shutdown.md).
- ~~Whether the strategy is chosen per deployment, or could vary per world once the per-game adapter exists.~~
  Answered 2026-08-27 by [ADR-0034](0034-per-game-adapter.md): the adapter exists, worlds already carry `game` and
  `host`, and connectivity — with its `auth` override — joins them as per-world catalog data when the first
  non-gating strategy is built.
