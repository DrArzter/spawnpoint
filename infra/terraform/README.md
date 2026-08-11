# infra/terraform

All AWS resources live here. Nothing is created by hand after M0, except the state backend itself.

Owns: VPC, subnet, internet gateway, route table, security group, EC2 instance and data volume, S3 buckets,
IAM roles and policies, Lambda functions, API Gateway, EventBridge rules, SNS topic, DynamoDB table, Route 53
records, CloudFront distribution, CloudWatch alarms, AWS Budgets.

Does not own: mod releases, the world, or anything else that is data rather than infrastructure. Those belong
to the release pipeline. See [ADR-0011](../../docs/adr/0011-terraform-for-infrastructure.md) and
[ADR-0009](../../docs/adr/0009-s3-as-mod-source-of-truth.md).

Secrets are never variables or outputs here. They live in SSM Parameter Store, created outside Terraform and
referenced by name.

Start flat. Split into modules when a single configuration genuinely hurts, not before.

State backend bootstrap is a manual, one-time step — see [the runbook](../../docs/runbook.md#bootstrap-terraform-state).

**Status:** empty. Populated in M1.
