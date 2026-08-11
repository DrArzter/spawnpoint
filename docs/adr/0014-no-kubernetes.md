# ADR-0014 — Do not use Kubernetes

- Status: Accepted
- Date: 2026-08-11
- Milestone: —

## Context

Kubernetes is the obvious thing to reach for when a project involves containers, and it is the most
marketable line on a CV of anything discussed here. A Minecraft operator exists, and running the server as a
StatefulSet with a persistent volume claim would work.

It is also the wrong tool for this workload, and it is worth writing down why, because the temptation will
return.

The workload is one container, on one host, for five players, running a few evenings a week. Kubernetes
solves scheduling across many hosts, rolling deployments of replaceable replicas, service discovery, and
horizontal scaling. This system has one of everything, and the one thing it does need — a stateful process
with a fixed port and a large heap — is the case Kubernetes handles least gracefully.

Cost decides it. EKS charges a fixed hourly rate per cluster for the control plane, in the region of
$70 per month at the time of writing, before a single node exists. Verify the current figure against the EKS
pricing page. Nodes, load balancers and NAT Gateway sit on top of that. The control plane alone would exceed
the entire target budget for this project, and it buys nothing that the workload uses.

## Decision

Do not use Kubernetes, EKS, or a self-managed cluster. Run one container on one instance with Docker Compose.
See [ADR-0005](0005-containerised-game-server.md).

If Kubernetes practice is wanted, do it as a separate exercise, on a cluster that is created and destroyed
per session, rather than attaching a permanent cost to a system that has no use for it.

## Consequences

**Good**

- The fixed monthly cost stays near zero, which is what makes the on-demand model worth building.
- Far less to operate, and far less to debug at midnight.
- No temptation to over-engineer the surrounding automation to match the platform.

**Bad, or risky**

- No Kubernetes experience from this project, which is a real gap in a CV.
- If the system ever did grow to several servers, this decision would need revisiting rather than extending.

**Mitigations**

- The container definition is portable. If a cluster ever becomes justified, the workload moves; the release
  pipeline and control plane do not care what runs the container.
- Practise Kubernetes elsewhere, on ephemeral clusters, or locally on kind or k3s where the control plane is
  free.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| EKS | Roughly $70 per month for the control plane alone, before nodes, for a single-container workload. Verify the current rate |
| EKS with Fargate profiles | Removes node management, does not remove the control-plane charge |
| Self-managed k3s or kind on the instance | Nearly free, and a reasonable way to learn. Rejected because it adds a cluster to debug on the one host that must come up reliably in three minutes |
| ECS | A fair middle ground: no control-plane charge, real orchestration, and what the prior art uses. Rejected with the compute model in [ADR-0004](0004-ec2-spot-for-the-game-server.md), not on cost |
| Nomad | Lighter than Kubernetes and a good fit technically, but one more thing to learn for no benefit at one host |
