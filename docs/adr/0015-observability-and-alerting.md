# ADR-0015 — Observability: CloudWatch for signals, chat for alerts, Budgets as the backstop

- Status: Proposed
- Date: 2026-08-11
- Milestone: M5

## Context

Nobody watches a dashboard for a hobby project. The realistic failure discovery path is a friend saying "the
server is down", which is both late and demoralising.

Three classes of problem need to be noticed:

1. **Availability.** The server did not start, or crashed, or the container is restarting in a loop.
2. **Cost.** The instance never stopped, or a resource was left behind after an experiment. This is the one
   that hurts, because the feedback arrives with the monthly bill.
3. **Health.** Tick time degrading, memory pressure, disk filling with world data or logs. These predict the
   first class of problem.

The system has no always-on component, so there is nothing to host an agent or a scraper on.

## Decision

Use CloudWatch as the store for metrics, logs and alarms, and the chat channels as the delivery mechanism for
anything that needs a human. See [ADR-0016](0016-chat-integrations.md).

Signals to collect:

| Signal | Source | Why |
| --- | --- | --- |
| Container state and restarts | Docker via a small reporter on the instance | Detects a crash loop after a release |
| Server reachable, player count | The idle check that already runs | Availability, and it is free — the check exists anyway |
| Tick time, heap use | Server logs or an RCON query | Predicts the pack becoming unplayable |
| Disk used on the data volume | CloudWatch agent | World and logs fill volumes quietly |
| Instance running hours | EC2 metrics | The cost signal that matters most |
| Spot interruption notice | Instance metadata, EventBridge | Triggers the save-and-stop path, and explains a disconnect afterwards |
| Game server logs | Log agent, filtered | Diagnosis after the fact |

Alarms, and what each does:

- **Instance running longer than a session should last** → chat alert. The single most valuable alarm here.
- **AWS Budgets threshold at a defined monthly figure** → chat alert, and email through an SNS subscription as
  the out-of-band path. Independent of everything above, because it must still arrive when the rest of the
  system is broken. See [ADR-0020](0020-email-channel.md).
- **Container restart loop** → chat alert, and it names the live release so the cause is obvious.
- **Data volume above a use threshold** → chat alert, non-urgent.
- **A backup did not complete after a session** → chat alert. A silent backup failure is the worst outcome
  in this system.

Log retention is finite and short. Indefinite retention of logs from a five-player server is a slow, pointless
cost.

## Consequences

**Good**

- Failures arrive where the group already talks, so they are actually seen.
- The cost alarm is independent of the application, so it survives the application being broken.
- Most signals come from checks that already exist for other reasons, so the marginal cost is small.
- The backup alarm closes the gap between "we have backups" and "we have backups that work".

**Bad, or risky**

- Alert fatigue. Anything that fires weekly and does not need action will be muted, and then the useful alert
  is muted with it.
- CloudWatch custom metrics, dashboards and log ingestion are billed per unit, and are easy to overuse.
- Alarms that are never tested may not fire when needed.

**Mitigations**

- Every alarm must have an action a human would actually take. If there is none, it is a metric, not an alarm.
- Keep custom metrics to the short list above, and use metric filters on logs sparingly.
- Test each alarm once, deliberately, by forcing the condition. Record in the runbook that it fired.
- Set the Budgets alarm before the first long-running resource exists, not after the first surprising bill.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Nothing; rely on players reporting problems | Free, and the default. Discovers cost problems a month late |
| Prometheus and Grafana, self-hosted | Much better dashboards and the industry-standard skill, but needs an always-on host, which contradicts the whole design |
| Grafana Cloud or a hosted free tier | Removes the always-on host and keeps the good dashboards. A reasonable later addition; rejected for now to avoid a second system before the basics work |
| Email alerts only | Works, and an SNS email subscription is the out-of-band fallback for Budgets, but email is not where this group looks. See [ADR-0020](0020-email-channel.md) |
| A status page | Nice, and partly covered by the control panel already showing status. Not an alerting mechanism |

## Open questions

- The monthly figure for the Budgets alarm. Set it once the cost model has real numbers. See [docs/costs.md](../costs.md).
- Whether the running-hours alarm should act rather than notify — stopping the instance itself. Listed as a
  decision still to record in the [ADR index](README.md).
- Whether tick time is worth the effort to extract, or whether "players complain about lag" is honestly good
  enough at this scale.
