# ADR-0031 — Keep a first-class local control-plane environment

- Status: Accepted
- Date: 2026-08-12
- Milestone: Cross-cutting, M1–M5
- Complements: [ADR-0014](0014-no-kubernetes.md), which still rejects Kubernetes for production

## Context

The game container already runs locally, but that exercises only the final host process. Most of this system's useful
behaviour lives before and after it: an API starts an operation, Step Functions waits and branches, Lambdas validate
state, DynamoDB holds pointers and leases, S3 holds releases and backups, and events reach notification adapters.

Testing those flows only in AWS makes every feedback loop slower, requires credentials and can create billable or
destructive resources. It also discourages deliberately testing the interesting failures: a health timeout, a corrupt
archive, a concurrent promotion, a failed rollback or a Spot interruption during save.

No local emulator proves that AWS IAM, Spot capacity, EBS attachment rules, availability zones, quotas or service
timing are correct. The goal is therefore behavioural development and integration testing, not a claim that a laptop
is AWS.

LocalStack can emulate the core APIs and Step Functions service integrations needed here, but it is an external
product with incomplete parity and a changing licence model. Current LocalStack distributions require an account,
an assigned licence and an auth token, including the non-commercial Hobby path. AWS Step Functions Local is explicitly
unsupported and lacks service parity. Neither may become a prerequisite for ordinary unit tests.

## Decision

Maintain a **first-class local control-plane environment** that can run one complete start, stop, backup, restore and
release-promotion operation against the local Minecraft session stack.

The production artefacts remain shared:

- the same Amazon States Language definitions;
- the same TypeScript Lambda handlers and domain code;
- the same release and backup formats;
- the same host scripts and machine-readable `key=value` contract;
- the same Terraform modules where the emulator supports the resource.

Only infrastructure boundaries are adapted:

| Production boundary | Local implementation |
| --- | --- |
| AWS service endpoints | LocalStack endpoints, provisioned by a local Terraform root using the normal modules where supported |
| EC2 lifecycle and SSM Run Command | A small `DockerHostAdapter`/local agent that starts the Compose session and invokes the same scripts |
| Route 53 or overlay publication | A deterministic local connection record, normally `127.0.0.1:25565` |
| Chat and email delivery | An event sink that records and displays notifications without contacting real people |
| Cognito identity | A development identity adapter for ordinary flows; emulator-backed identity tests remain optional |
| Spot and infrastructure failures | Explicit fault-injection commands and scripted adapter responses |

The intended developer entry point is one command such as `make local-up`; the exact command lands with the first
control-plane Lambda. It starts LocalStack, the built Lambda artefacts, the local host adapter and the existing
Minecraft/Prometheus/Grafana Compose session. A matching reset command deletes only namespaced local state.

LocalStack is an **opt-in full integration dependency**. Its auth token lives in an ignored environment file or local
secret store, never Terraform variables, Compose files or Git. Unit tests for Lambda domain logic, manifest handling
and ASL validation run without it. CI must not silently depend on a developer's Hobby licence; adding licensed CI use
requires an explicit later decision.

Workflow timing is injectable at execution input or deployment configuration: local tests may use seconds where
production uses minutes, without maintaining a second state machine. Production defaults and limits are still tested
against real AWS before a milestone is accepted.

Kubernetes is not the default local runtime. A disposable kind or k3s implementation may later satisfy the same host
adapter contract as a learning exercise. It must not change the control-plane domain model or weaken
[ADR-0014](0014-no-kubernetes.md)'s production decision.

## Consequences

**Good**

- A whole operation can be watched and debugged locally, including Step Functions execution history and rollback.
- Failure paths become cheap and repeatable rather than dangerous production experiments.
- Lambda code, ASL, Terraform modules and host scripts are forced to have explicit boundaries instead of importing
  global AWS state everywhere.
- The local environment is a useful demonstration: one command shows the service, not only its architecture diagram.
- The Docker adapter can run the real restored world and the same observability stack already exercised locally.

**Bad, or risky**

- The project now supports a second execution environment and must prevent it drifting from AWS.
- Emulator success can create false confidence about IAM, networking, quotas and eventual consistency.
- LocalStack account and licence requirements make full integration less self-contained than Docker Compose alone.
- Fault injection is code that must itself remain understandable; an overbuilt simulator would become another product.

**Mitigations**

- Share domain code and deployment artefacts; adapters contain endpoints and transport, never business rules.
- Keep a small real-AWS smoke suite for the behaviours emulators cannot prove.
- Mark tests by level: unit, local integration and AWS acceptance. A green local suite is not an AWS acceptance result.
- Keep fault injection scenario-based: capacity unavailable, host command timeout, unhealthy server, corrupt archive,
  interrupted save and failed rollback. Do not attempt a general EC2 simulator.
- Pin the LocalStack image and record its required plan before adding it to the Compose environment.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Test only in AWS | Highest fidelity, but slow, credentialed, billable and hostile to destructive failure testing |
| LocalStack everywhere, including unit tests | One apparent environment, but makes basic development depend on an external licence and emulator availability |
| AWS Step Functions Local plus separate DynamoDB/S3 emulators | AWS-owned workflow runtime, but officially unsupported and without parity; wiring several unrelated emulators is more drift than one opt-in integration environment |
| Kubernetes as the local platform | Excellent practice for Kubernetes, but emulates a scheduler this production system does not use and does not reproduce Step Functions semantics |
| Reimplement the workflow engine in TypeScript | Completely local and debuggable, but creates a second orchestrator whose behaviour can diverge from ASL retries, catches and service integrations |
| Unit tests only | Necessary and fast, but cannot demonstrate that the workflow, Lambda packaging, persistence and host scripts compose into a service |

## First implementation slice

When the first M2 start workflow lands, local mode is complete enough to be useful when it can:

1. provision local buckets, tables, topic, Lambda and one Standard state machine;
2. accept a local start request and return an operation/execution ID;
3. invoke the Docker host adapter, start the real Compose session and wait for Minecraft health;
4. commit `active_release` only after the same health contract as production;
5. show the execution result and notification event;
6. repeat the test with an injected health failure and observe the rollback branch.
