# infra/terraform-guardrails

Cost and alerting guardrails for the account: the alert topic, the monthly budget, and cost anomaly detection.

Its own root because it serves a distinct purpose — cost and alerting, not compute and not object storage — and its
lifecycle is its own: persistent, surviving every host teardown, with thresholds re-tuned occasionally. The cost of
that separation is a new state key, and therefore a new lock-cleanup rule in
[`../terraform-bootstrap`](../terraform-bootstrap/); that rule is added, not left implicit.

Owns: one SNS topic (`spawnpoint-alerts`) with a service-scoped access policy, its email subscription, an
`aws_budgets_budget` with a forecasted and an actual threshold, and an optional cost anomaly monitor and subscription.

## Order

`bootstrap` → **`guardrails`** → `storage` → `host`.

Before the host on purpose: the budget must exist before anything that can spend. After bootstrap because it uses the
S3 backend bootstrap creates; the only thing that exists before it is the state bucket, which is effectively free. It
has no dependency on `storage`, so those two could swap — the budget is simply placed as early as the remote backend
allows.

Implements decisions already recorded — alerting in [ADR-0015](../../docs/adr/0015-observability-and-alerting.md) and
the account setup in [docs/aws-account-checklist.md](../../docs/aws-account-checklist.md). Not itself an ADR: it is the
Terraform form of guardrails previously created by hand in the console.

## The one manual step

The SNS email subscription is created `PendingConfirmation`. Terraform cannot confirm it; the recipient clicks the link
AWS emails, once. That single click in an inbox is the only action this root leaves to a human — everything else is
code plus an `alert_email` variable.

## Adopting the existing manual resources

This account already has a budget, an SNS topic and an anomaly subscription created by hand during the account
walkthrough — see [the runbook](../../docs/runbook.md#account-bootstrap). A blind first `apply` would clash on the
duplicate names. Before the first apply, either:

- `terraform import` each existing resource into this root's state (budget by name, topic and subscriptions by ARN,
  anomaly monitor and subscription by ARN), then `plan` until it reports no changes; or
- delete the manual ones in the console and let Terraform create them fresh.

Import is preferred: it keeps the already-confirmed email subscription rather than re-triggering the confirmation click.

## Why `include_credit = false`

The budget measures cost before credits, so it still fires on a runaway while Free Plan credits would otherwise net the
reported amount to zero. This is the credit trap recorded in
[docs/aws-account-checklist.md](../../docs/aws-account-checklist.md).

## Running

From the pinned official container, as elsewhere in `infra/`:

```bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" -w /workspace/infra/terraform-guardrails \
  hashicorp/terraform:1.15.8 fmt -check -diff

docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" -w /workspace/infra/terraform-guardrails \
  hashicorp/terraform:1.15.8 init -backend=false

docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" -w /workspace/infra/terraform-guardrails \
  hashicorp/terraform:1.15.8 validate

docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" -w /workspace/infra/terraform-guardrails \
  hashicorp/terraform:1.15.8 test
```

Apply needs the real backend and the email:

```bash
terraform init -backend-config=backend.hcl
terraform apply -var alert_email=you@example.com
```

The tests use the mock AWS provider: no credentials, no resources created. They assert the topic name, the email
subscription, both budget thresholds, `include_credit = false`, and that anomaly detection is planned only when enabled.

## Status

New, not yet applied. `fmt`, `validate` and `test` were **not run** in the authoring environment — no terraform binary
there — so run the container commands above before trusting it. The account's guardrails currently exist as manual
console resources, to be adopted per the section above.
