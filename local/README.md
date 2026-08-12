# Local control plane

This directory will be the one-command behavioural environment from
[ADR-0031](../docs/adr/0031-first-class-local-control-plane.md). It is intentionally not a second implementation of
Spawnpoint.

## Target topology

```text
local caller
    |
    v
API Gateway -> Lambda -> Step Functions -> Lambda / direct AWS-shaped integrations
                 |             |                         |
                 +-------------+-------------------------+
                               |
                          LocalStack
                 S3 / DynamoDB / SNS / EventBridge
                               |
                        DockerHostAdapter
                               |
              Minecraft + Prometheus + Grafana Compose
```

The local environment will reuse:

- production ASL definitions;
- built TypeScript Lambda packages;
- Terraform modules where LocalStack supports the resource;
- `server/scripts/` for start, health, save, stop, archive, restore and release reconciliation;
- the real disposable Minecraft world fixture when an end-to-end test needs it.

## Test levels

| Level | Needs LocalStack | Proves |
| --- | --- | --- |
| Unit | No | Domain rules, manifest parsing and adapter contracts |
| Local integration | Yes, opt-in | Workflow branching, packaging, persistence and Docker host interaction |
| AWS acceptance | Real AWS | IAM, networking, Spot, EBS/AZ, quotas and actual service timing |

## Planned first command

`make local-up` arrives with the first M2 start workflow. It will require `LOCALSTACK_AUTH_TOKEN` from an ignored
local environment file, because current LocalStack distributions require an assigned licence. No token or AWS secret
will be committed here.

The first useful scenario is deliberately small: request start, observe the Standard workflow start the local Compose
session, pass Minecraft health, and commit `active_release`; then run the same scenario with an injected health failure
and observe rollback.

**Current status:** the downstream Docker side already exists and has been exercised with the real restored world.
The LocalStack composition starts when the first Lambda and ASL definition exist; adding an emulator container before
there is anything for it to execute would create configuration without a testable behaviour.
