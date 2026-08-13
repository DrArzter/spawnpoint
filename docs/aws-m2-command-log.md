# AWS M2 command log

Executed on 2026-08-14 with profile `spawnpoint` in `eu-central-1`. M2 begins with one vertical slice: a Standard Step
Functions start operation. It starts the existing Terraform EC2, waits without a running Lambda, invokes one constant
SSM host command and returns ready only through the host's private-session contract.

## What was created

Terraform applied a saved **3 add / 0 change / 0 destroy** plan:

| Resource | Purpose |
| --- | --- |
| `spawnpoint-start-server` | Standard state machine; durable operation/execution history |
| `spawnpoint-start-workflow` IAM role | Trusts only Step Functions from this account and `spawnpoint-*` machines |
| Inline policy of the same name | Starts only the Terraform game host and sends only `AWS-RunShellScript` to that host |

Read APIs whose AWS authorization model does not support useful resource scoping remain `Resource="*"`:
`ec2:DescribeInstances`, `ssm:DescribeInstanceInformation` and `ssm:GetCommandInvocation`. Mutation is scoped to
`i-09c9b5069308ac372`.

The ASL definition passed the service's read-only validator before creation:

```bash
aws stepfunctions validate-state-machine-definition \
  --definition file://workflows/start-server.asl.json \
  --type STANDARD \
  --severity WARNING \
  --profile spawnpoint \
  --region eu-central-1
```

Result: `OK`, no diagnostics. Terraform mock tests also assert Standard type and direct EC2/SSM integrations.

## Rejected destructive plan

The first production plan proposed replacing the stopped EC2 and its EBS attachment: AWS reports the instance-level
`associate_public_ip_address=false` while a stopped instance has no ephemeral public address, whereas configuration
requests an address on start. Applying that plan would have needlessly replaced the host.

It was deleted without apply. Terraform now ignores only that stopped-state readback; the public subnet retains
`map_public_ip_on_launch=true`. The rebuilt saved plan contained only the three resources above. This is why plans are
reviewed before apply even when the requested feature appears unrelated to compute.

## Host preparation

Immutable bundle `releases/1.0/server/spawnpoint-server-7686f39.tar.zst` was downloaded by the instance role and
verified as SHA-256 `086b48d7ad3ff64e936cf7b1069a5713e349139c9ab14b2f5103bb5f6aa43909`. The root-owned `.env` remained mode
`0600` and received the trusted ZeroTier network/address. No secret was printed. Compose tests passed and all
containers remained stopped. SSM command: `c97653d5-d42f-43c6-a230-c40da5dc4ff0`.

`start-session.sh` obtains those values from the trusted host environment rather than interpolating execution input
into a shell command. The workflow sends only:

```text
set -euo pipefail
/srv/spawnpoint/app/server/scripts/start-session.sh
```

That prevents an operation payload from becoming shell syntax.

## First execution

Execution `m2-first-start-20260814` started with EC2 stopped and completed `SUCCEEDED` in **120 seconds**. The state
machine directly called EC2 and SSM; no Lambda existed or waited. Host command
`1d63d7f2-1660-4d92-b385-86d1026ff5a1` completed in **95 seconds** and returned the private address
`172.29.23.24:25565`.

The first input polled SSM every 5 seconds and produced 286 history events, 106 state entries, 24 SDK tasks and 21
waits. That is observable but unnecessarily noisy. The owner trigger now uses 15-second command polling, bounded at 60
polls. A callback can replace polling later if the history remains too chatty.

The first host version accepted RCON while Docker health was still `starting`; an immediate independent check found
Minecraft `healthy`, RCON ready, zero restarts/OOM, Grafana healthy and TCP 25565 reachable. Commit `8118e63` tightened
the reusable host lifecycle rule: when a Docker health check exists, both `healthy` and RCON are required. Bundle
`spawnpoint-server-af94f0b.tar.zst`, SHA-256
`54c3a9c96af7ee527f5dbb3d1cec88d6a3fbcd8e7c9766c230d8f1f36fb57722`, was deployed without recreating Minecraft by
SSM command `45d0a9f2-f49e-4b13-8c08-faed21fb4780`.

The minimal authenticated trigger is now:

```bash
scripts/start-server.sh
```

It resolves the Terraform resources, refuses to create a parallel execution while one is RUNNING, starts the durable
operation and follows its terminal result. `--no-follow` returns immediately. A repeat against the already-ready host
completed `SUCCEEDED` with `result=already_ready` and elapsed 0, proving the host step is idempotent. The list-then-start
check is not an atomic single-flight lock; that lease is still required before exposing the trigger to concurrent
players.
