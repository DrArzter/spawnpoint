# ADR-0006 — Start on demand, stop when idle

- Status: Accepted
- Date: 2026-08-11
- Milestone: M2

## Context

Compute cost is proportional to running hours. The group plays a few evenings a week, so an always-on
server spends most of its life idle. Stopping the instance when nobody is online is the largest saving
available — larger than the Spot discount, and the two multiply.

The awkward part is starting it again. Players cannot be expected to open the AWS console, and the
person who has console access should not be the bottleneck for everyone else's evening.

The prior art wakes the server implicitly: Route 53 query logging catches the client's failed DNS
lookup and triggers the start. Elegant, and it needs no button. It also has no idea *who* asked, which
matters here — the group wants a chat message saying who started the server, and abuse of a public
start trigger needs to be attributable. See [ADR-0016](0016-chat-integrations.md).

## Decision

Start the server from an **explicit request** carrying an identity: a button in the web panel, or a
command to the Discord or Telegram bot. All of these call the same control-plane API, which starts the
instance and reports progress. See [ADR-0012](0012-web-control-panel.md).

Stop it automatically: a scheduled check reads the player count from the running server, and after a
number of consecutive empty readings it saves the world and stops the instance.

Assumption to verify in M2: a cold start of 1–3 minutes is acceptable to the players. If it is not,
add the implicit DNS wake as a second trigger, keeping the explicit one for attribution.

## Consequences

**Good**

- Cost tracks actual use. An idle week costs storage and DNS only.
- Anybody in the group can start the server, without AWS access.
- Every start has a requester attached, which makes both the chat notification and the audit trail
  possible.
- The status surface removes the daily "is it up?" question, which is the real day-to-day annoyance.

**Bad, or risky**

- A cold start before every session. Modded packs load slowly, so this may exceed 3 minutes.
- A public start trigger is a public trigger for spending money.
- The idle check must never stop a server that has players in it. A wrong reading disconnects everybody.
- If the stop path fails silently, the instance runs all month and the bill is the first warning.

**Mitigations**

- Require identity on every start request, rate-limit per requester, and log who started what.
- Require several consecutive empty readings, and treat a failed reading as "not empty".
- Stop only after an explicit, confirmed world save.
- A CloudWatch alarm on continuous running hours, plus an AWS Budgets alarm as the backstop. See
  [ADR-0015](0015-observability-and-alerting.md).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Always on | Simple and instant, but pays for roughly 90% idle time. The problem this project exists to solve |
| Implicit wake on DNS query, as in the prior art | Best player experience and no button, but anonymous, so no requester to attribute or rate-limit. Kept as a possible second trigger if cold start proves painful |
| Wake via an always-on proxy holding the connection | Nicest experience of all, but reintroduces a fixed monthly cost and a component that can fail |
| Fixed schedule, up 18:00–24:00 | Trivial, but pays for empty evenings and fails on the unplanned ones |
| Manual start from the console or CLI | Zero build cost, and this is the M0 behaviour, but it makes one person a dependency |

## The pattern turned out to be regular

Recorded here because it changes the weight of three things above, without changing the decision.

The expected pattern is **2–3 hours most nights**, roughly 75 hours a month. That is still only about 10% of the month,
so the case for stopping when idle is undamaged — the always-on alternative is around six times the cost. But a regular
nightly pattern has three consequences:

1. **The cold start is paid every single night**, not a few times a week. Whatever it measures at, it is now the most
   frequently felt piece of friction in the system. This raises the value of a low-friction trigger — a `start` from the
   phone via Telegram — and of the pre-warm option below.
2. **Spot interruptions stop being an edge case.** More hours means more exposure, and at this usage an interruption
   becomes something to expect periodically rather than to handle theoretically. The announcement to chat matters
   correspondingly more: players should learn *why* they were dropped rather than guess.
3. **The idle threshold needs care.** A 15-minute threshold and a nightly session with breaks will eventually stop the
   server while somebody is making tea. Annoying once a month is tolerable; annoying weekly is not, which promotes the
   keep-alive question below from a nicety to something worth building.

Nights are also, in a European region, the region's own low-demand hours, so Spot prices and interruption rates are
plausibly better then. Expected rather than established — check against Spot price history for the candidate instance
types before relying on it.

## Open questions

- **A scheduled pre-warm.** If play reliably starts around the same time, starting the instance a few minutes before
  removes the cold start entirely. The cost of a pre-warm nobody uses is a few minutes of instance time — under two
  cents — and the idle watchdog stops it by itself if nobody arrives. It does slightly compromise the purity of "started
  by an explicit request", and it must not race the watchdog. Worth doing once the pattern is confirmed over a few weeks;
  not worth building on an assumed schedule.
- Measured cold start time for the real pack. Everything above depends on it, and with nightly play it is felt daily.
- Source of the player count: RCON, the server list ping protocol, or a log tail. RCON is the most
  direct and is the starting assumption.
- Idle threshold. Start at 15 minutes and adjust after observing real sessions; with nightly play, expect to raise it.
- A "keep alive for another hour" command for a break mid-session. Promoted from a nicety by the nightly pattern: a
  threshold that misfires occasionally will misfire often enough to matter when sessions are daily.
