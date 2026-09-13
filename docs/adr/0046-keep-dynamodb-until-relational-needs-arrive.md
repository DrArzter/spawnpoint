# ADR-0046 — Keep DynamoDB until relational needs arrive

- Status: Accepted
- Date: 2026-09-13
- Milestone: cross-cutting

## Context

The current access directory, login sessions and control-plane state are addressed by known keys and indexes. They need conditional writes, short request latency, TTL cleanup and no always-ready database connection pool. DynamoDB already supplies those properties and the project is small enough that changing a bounded context later remains practical.

Aurora Serverless can auto-pause at zero ACUs on supported versions, but storage and other cluster charges remain while paused, and resuming commonly adds seconds of latency. It becomes valuable when Spawnpoint has real relational integrity, multi-entity transactions, joins, ad-hoc reporting or query patterns that would otherwise multiply DynamoDB indexes. AWS documents the zero-ACU behavior and resume trade-offs in [Automatic pause and resume for Aurora Serverless](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html).

## Decision

Continue using DynamoDB for current key-addressed bounded contexts, including provider-neutral login sessions. Introduce Aurora only for a bounded context whose demonstrated relational workload justifies it; do not replace DynamoDB wholesale or split data between both stores merely by category.

## Consequences

**Good**

- Login and control-plane requests keep their existing serverless cost and latency shape.
- The project avoids connection management, schema migrations and resume latency before they solve a real problem.
- Aurora remains available for future relational workloads without forcing unrelated state to migrate.

**Bad, or risky**

- Some future queries may require new DynamoDB indexes or projections before the relational threshold is obvious.
- A later bounded-context migration must temporarily operate across two persistence technologies.

**Mitigations**

- Treat rapidly multiplying access patterns, cross-entity invariants and reporting queries as explicit triggers to reassess this decision.
- Keep persistence behind domain-oriented interfaces so a future migration is scoped to one bounded context.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Move all current data to Aurora Serverless now | No current relational workload repays the additional schema, connection, cold-resume and baseline storage complexity |
| Adopt a hybrid store immediately | Two databases without distinct bounded-context needs doubles operational surface and creates ambiguous ownership |
| Rule out SQL permanently | Future account linking, billing, tenancy or reporting may genuinely fit relational constraints and queries better |
