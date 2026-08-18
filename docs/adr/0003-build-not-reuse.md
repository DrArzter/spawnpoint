# ADR-0003 — Build the platform from scratch, rather than reuse an existing on-demand template

- Status: Accepted
- Date: 2026-08-11
- Milestone: —

## Context

On-demand Minecraft hosting on AWS is already solved in public. The best known example is
`doctorray117/minecraft-ondemand`: a CDK template that runs the server as an ECS Fargate task with a
sidecar watchdog, and wakes it by logging Route 53 DNS queries to CloudWatch, which triggers a Lambda
that scales the service to one task. The watchdog updates the DNS record to the new task IP and
scales back to zero after a period with no players. It is a clean design, and the DNS-query trigger
is a genuinely clever way to avoid any always-on component.

Deploying that template would give a working server in an evening.

It would also skip the entire reason this project exists. The declared goal is to learn production
engineering by hitting the problems personally: capacity, IAM, interruption handling, state, backups,
cost. A template hides exactly those problems.

Two substantive differences also exist, independent of learning:

1. **Compute model.** This project uses one EC2 instance with a persistent EBS volume, not Fargate. See
   [ADR-0032](0032-on-demand-single-instance.md), which supersedes the Spot decision this originally cited.
2. **Scope.** The existing template does not manage mod releases, does not version them, and does not
   distribute a matching client pack. That pipeline and its control panel are the point of this
   project, not the on-demand start. See [ADR-0008](0008-versioned-mod-releases.md),
   [ADR-0012](0012-web-control-panel.md), [ADR-0013](0013-modpack-distribution.md).

## Decision

Build every layer in this repository from scratch: network, compute, lifecycle automation, mod
pipeline, control panel, observability.

Read prior art deliberately and record what is worth borrowing at the level of ideas, not code. Prior
art notes live in [docs/prior-art.md](../prior-art.md). Copy no code without attribution and a licence
check.

This is a deliberate trade of delivery speed for depth of understanding. It is the correct trade
here, and would be the wrong trade for a system with a deadline or a customer.

## Consequences

**Good**

- Every component is understood well enough to debug and to defend in an interview.
- Freedom to choose the compute and storage model that fits, instead of inheriting Fargate and EFS.
- The mod pipeline, which is the genuinely new part of this design, is built on foundations that were designed
  for it.

**Bad, or risky**

- Slower to a playable server. Weeks of evenings, not one evening.
- Some effort re-solves solved problems, and the first solution will be worse than the mature one.
- Higher risk of a security or cost mistake, because there is no reviewed template guarding the
  defaults.

**Mitigations**

- M0 is a deliberately throwaway manual spike, to get something playable early and keep motivation.
  See [docs/roadmap.md](../roadmap.md).
- Read prior art before building each layer, and record what was borrowed and what was rejected.
- Cost and security guardrails go in before long-running resources: Budgets alarm, no inbound SSH, no
  NAT Gateway, least-privilege instance profile.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Deploy `minecraft-ondemand` as is | Fastest path to a working server, but delivers none of the learning and none of the mod pipeline |
| Fork it and extend | Tempting middle ground, but inherits Fargate and CDK, and understanding a fork well enough to extend it safely costs nearly as much as building the parts |
| Use it for the wake/sleep layer and build the pipeline on top | The most pragmatic option, and the one to fall back to if the project stalls. Rejected for now because the lifecycle layer is where most of the learning is |
| A hosting panel such as Pterodactyl or Crafty | Solves server management with a good UI, but it is somebody else's control plane, which is the part being built here |
