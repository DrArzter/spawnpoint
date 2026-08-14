# infra/terraform

Disposable game-host AWS resources live here. Persistent object storage has its own lifecycle in
[`../terraform-storage`](../terraform-storage/), cost guardrails in
[`../terraform-guardrails`](../terraform-guardrails/), and the state backend in
[`../terraform-bootstrap`](../terraform-bootstrap/). Apply order: bootstrap → guardrails → storage → this root — the
budget exists before anything that can spend.

Owns now: VPC, subnet, internet gateway, route table, security group, EC2 instance and data volume, and the game-host
IAM role/policies. Later roots may own Lambda functions, Step Functions, API Gateway, EventBridge, SNS, DynamoDB,
Route 53, CloudFront, CloudWatch alarms and AWS Budgets as their lifecycle boundaries become clear.

Does not own: mod releases, the world, or anything else that is data rather than infrastructure. Those belong
to the release pipeline. See [ADR-0011](../../docs/adr/0011-terraform-for-infrastructure.md) and
[ADR-0009](../../docs/adr/0009-s3-as-mod-source-of-truth.md).

Secrets are never variables or outputs here. They live in SSM Parameter Store, created outside Terraform and
referenced by name.

Start flat. Split into modules when a single configuration genuinely hurts, not before.

The first split that is justified is an environment root, not duplicated resources: production AWS and the opt-in
LocalStack environment consume the same modules where API coverage permits. Endpoint overrides, dummy credentials and
unsupported edge resources live in the local root. They must not leak into production variables or produce a second
copy of the state-machine definition. See
[ADR-0031](../../docs/adr/0031-first-class-local-control-plane.md).

State backend bootstrap is a one-time, separately stateful Terraform step in
[`../terraform-bootstrap`](../terraform-bootstrap/) — see
[the runbook](../../docs/runbook.md#bootstrap-terraform-state).

## Current slice

The current compute/M2 lifecycle slice owns 24 resources: one VPC, one public subnet and route, a
zero-ingress security group, an SSM-only EC2 role/profile with scoped storage access, one on-demand EC2 host, and one
separately attached encrypted data EBS, plus Standard start and verified-stop state machines with separate dedicated
IAM roles/policies, and the currently inert Lifecycle V2 coordination table plus coordinator Lambda, dedicated role,
policy and bounded log group. The physical AZ ID is asserted because the volume is zonal. The instance has no SSH key
and requires IMDSv2.

`spawnpoint-lifecycle-v2` is an encrypted, deletion-protected, on-demand DynamoDB table keyed only by `server_id`.
It has no stream, secondary index or provisioned capacity, and V1 does not reference it. Its coordinator role can only
read and conditionally replace that table item and write the function's own 14-day logs; no V1 principal can invoke
the function. DynamoDB TTL is deliberately disabled: lease expiry is checked atomically by a conditional write, while
TTL cleanup is asynchronous and must never delete the current lifecycle record. See the additive rollout in
[`docs/lifecycle-v2-rollout.md`](../../docs/lifecycle-v2-rollout.md).

The game-host role can write and verify backup objects and read immutable release objects. It cannot change bucket
configuration or delete objects. Exact `5 daily / 2 weekly / 2 monthly` pruning belongs to the later backup operation:
S3 lifecycle deletes by object age, not by "keep the newest N" semantics, so pretending it implements that policy
would silently weaken the ADR.

`m7i-flex.large` is the default while the account remains on the Free Plan. `r8i-flex.large` is the reviewed 16 GiB
upgrade, but selecting it requires an explicit Paid Plan decision. The full-group memory measurement decides whether
that upgrade is needed; Terraform does not quietly make a billing-plan decision.

Terraform is run from its pinned official container, so no system installation is needed:

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 fmt -check -diff

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 init -backend=false

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 validate

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 test
```

The tests use Terraform's mock AWS provider: they require no credentials and cannot create resources. They assert the
Free Plan instance choice, zero ingress, IMDSv2, termination protection, root/data EBS semantics, consumption of the
separately managed buckets, the reviewed paid upgrade and rejection of unreviewed instance types.

The committed S3 backend intentionally has no bucket name. The real ignored `backend.hcl` now points to the bootstrapped
production bucket; `backend.hcl.example` documents the shape without publishing account-specific configuration. Never
pass credentials through that file: Terraform can persist backend arguments in `.terraform/` and plan files. The
non-secret profile name belongs in it because the S3 backend is initialised before, and independently from, the AWS
provider configuration.

The earlier combined plan was split before apply so destroying compute can never include backup/release buckets. The
persistent storage root was applied separately and is drift-free. The compute root was applied from a saved plan on
2026-08-13: **13 added, 0 changed, 0 destroyed**, with no S3 resource actions. A fresh plan after apply reported no
changes.

**Status:** state, persistent storage and M1 compute/network are live and drift-free. The restored M1 world passed its
in-game acceptance test, was saved, archived to verified S3 and the Terraform host was stopped on 2026-08-14. Its
encrypted 20 GiB data EBS remains attached with `DeleteOnTermination=false`. The manual M0 host also remains stopped;
deleting those superseded manual resources is a separate, explicit cleanup decision.

The first M2 plan initially proposed replacing the stopped EC2 because AWS reads its ephemeral
`associate_public_ip_address` attribute as false while no address is attached. That saved plan was rejected. The
instance now ignores only that stopped-state readback; `aws_subnet.public.map_public_ip_on_launch=true` remains the
source of truth for the next start. The rebuilt plan was **3 add, 0 change, 0 destroy** and created only the Step
Functions role, scoped inline policy and Standard state machine. A post-apply plan reported no changes.

The stop slice likewise planned **3 add, 0 change, 0 destroy**. Its first apply created the role and policy, then
failed locally because the Docker invocation mounted only `infra/terraform` while `file()` reads the ASL definition
from the repository-level `workflows/` directory. No existing AWS resource changed. A new plan with the repository
root mounted contained only the remaining state machine; it was applied and a fresh plan reported no changes.
