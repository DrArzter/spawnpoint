# ADR-0015 — Session Grafana and Prometheus, CloudWatch for durable signals

- Status: Accepted
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

The system has no always-on compute component. That prevents a permanently self-hosted monitoring server, but it does
not prevent dashboards that exist for exactly the same lifetime as a game session. Players need detailed performance
graphs while diagnosing lag; AWS lifecycle and cost alarms need to survive after the game instance disappears.

## Decision

Use two deliberately different lifetimes:

- **Prometheus and Grafana run in the game server's Compose project.** They start and stop with Minecraft. Prometheus
  scrapes the Minecraft status exporter, cAdvisor and node_exporter. Grafana is provisioned from files and provides the
  session dashboard. Neither service creates always-on compute cost.
- **CloudWatch remains the durable AWS store** for lifecycle state, bounded logs and alarms that must exist while the
  game instance is absent. Chat channels deliver anything that needs a human. See
  [ADR-0016](0016-chat-integrations.md).

Prometheus listens on loopback only. Grafana is published on the host's port 3000 so members of the selected private
overlay can use one remote address without occupying a local port or maintaining an SSM tunnel. In mode C it may bind
to `0.0.0.0`, but **port 3000 must remain absent from the EC2 security group**: the zero-inbound security group is the
public/VPC boundary, and ZeroTier is the only supported path. SSM port forwarding remains a diagnostic fallback.

Anyone admitted to the ZeroTier network can reach the Grafana login page, so Grafana authentication still matters.
Prometheus, cAdvisor and node_exporter are not published to the overlay. Their local Docker volumes may disappear with
the disposable instance. That is acceptable: Prometheus history is a session debugging tool, not a backup or
control-plane source of truth.

Signals to collect:

| Signal | Source | Why |
| --- | --- | --- |
| Container state and restarts | Docker via a small reporter on the instance | Detects a crash loop after a release |
| Server reachable, player count | The idle check that already runs | Availability, and it is free — the check exists anyway |
| Minecraft status, response time, players | `mc-monitor` → Prometheus | Session availability and demand |
| Container CPU and memory | cAdvisor → Prometheus | Shows the actual Minecraft cgroup rather than guessing from host percentages |
| Host CPU, memory and disk | node_exporter → Prometheus; selected durable alarms in CloudWatch | Diagnoses a session and warns before the data volume fills |
| Tick time, heap use | Future JVM/game exporter or bounded log-derived metric | Predicts the pack becoming unplayable; not present in the first dashboard |
| Instance running hours | EC2 metrics | The cost signal that matters most |
| Spot interruption notice | Instance metadata, EventBridge | Triggers the save-and-stop path, and explains a disconnect afterwards |
| Game server logs | Log agent, filtered | Diagnosis after the fact |

Alarms, and what each does:

- **Instance running longer than a session should last** → chat alert. The single most valuable alarm here.
- **AWS Budgets threshold at a defined monthly figure** → chat alert, and email through an SNS subscription as
  the out-of-band path. Independent of everything above, because it must still arrive when the rest of the
  system is broken. See [ADR-0020](0020-email-channel.md).
- **Container restart loop** → chat alert, and it names both desired and active release so the cause is obvious.
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
- The same dashboard works locally and on EC2, and teaches the standard Prometheus/Grafana model without a managed
  Grafana workspace that costs more than the game server.

**Bad, or risky**

- Alert fatigue. Anything that fires weekly and does not need action will be muted, and then the useful alert
  is muted with it.
- CloudWatch custom metrics, dashboards and log ingestion are billed per unit, and are easy to overuse.
- Alarms that are never tested may not fire when needed.
- cAdvisor needs broad read access to host and Docker state. It is not published on a host port and must not be treated
  as an application security boundary.
- Binding Grafana on all host interfaces is safe only while the security group has zero inbound rules. A future public
  connectivity mode must force Grafana back to loopback before adding game ingress.
- Session metrics disappear when the disposable instance is replaced. Cross-session trends require selected
  CloudWatch metrics, not a promise that the local Prometheus volume is durable.

**Mitigations**

- Every alarm must have an action a human would actually take. If there is none, it is a metric, not an alarm.
- Keep custom metrics to the short list above, and use metric filters on logs sparingly.
- Test each alarm once, deliberately, by forcing the condition. Record in the runbook that it fired.
- Set the Budgets alarm before the first long-running resource exists, not after the first surprising bill.
- Assert zero security-group ingress whenever mode C publishes Grafana on `0.0.0.0`; do not rely on operator memory.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Nothing; rely on players reporting problems | Free, and the default. Discovers cost problems a month late |
| Prometheus and Grafana on an always-on host | Better long-term dashboards, but creates fixed compute for data that is useful mainly during play |
| Grafana Cloud or a hosted free tier | Removes the always-on host and keeps the good dashboards. A reasonable later addition; rejected for now to avoid a second system before the basics work |
| Amazon Managed Grafana | Operationally easy, but its minimum editor licence costs more than the modelled hobby server; no need for it while session-local dashboards are sufficient |
| Email alerts only | Works, and an SNS email subscription is the out-of-band fallback for Budgets, but email is not where this group looks. See [ADR-0020](0020-email-channel.md) |
| A status page | Nice, and partly covered by the control panel already showing status. Not an alerting mechanism |

## Open questions

- The monthly figure for the Budgets alarm. Set it once the cost model has real numbers. See [docs/costs.md](../costs.md).
- Whether the running-hours alarm should act rather than notify — stopping the instance itself. Listed as a
  decision still to record in the [ADR index](README.md).
- How to export MSPT, JVM heap and GC without making an unmaintained gameplay mod part of the monitoring contract.
