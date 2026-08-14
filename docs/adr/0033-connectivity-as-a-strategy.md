# ADR-0033 — Connectivity is a strategy behind one interface, constrained by the game's auth model

- Status: Proposed
- Date: 2026-08-14
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
game that authenticates its own players — the Steam-based servers, Factorio, Project Zomboid — needs no such gate, and
there a public address or a DNS name is fine and cheaper to onboard. So the correct connectivity is a function of the
game's auth model, not a global preference.

**One combination is unsafe and should be impossible by construction.** A no-auth game reached over a non-gating
connectivity is an open server. Today that is prevented only by prose spread across
[ADR-0022](0022-minecraft-account-as-linked-identity.md) and [ADR-0024](0024-connectivity-modes.md). It should be an
invariant checked at the seam, not a thing a future edit can quietly violate.

## Decision

**Connectivity is a strategy behind one interface.** The start and stop lifecycle, the "announce the address" step and
the readiness check depend only on the interface, never on which strategy is active.

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
if not game.auth_provides_identity and not strategy.is_gate:
    refuse to start
```

So offline-mode Minecraft may run only behind a gating strategy; a self-authenticating game may use any. This is the
prose of [ADR-0022](0022-minecraft-account-as-linked-identity.md) turned into a rule that cannot be forgotten.

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
- The unsafe combination becomes unrepresentable rather than merely discouraged.
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
- Encode the gate-versus-auth invariant as a validation that fails the start, and cover it with a test.

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
- Whether the strategy is chosen per deployment, or could vary per world once the per-game adapter exists. That adapter
  — image, data directory, health probe, player-count probe, auth model, and this connectivity axis — is the larger
  decision this one is a slice of, and it stays a placeholder until a second game is actually on the table.
