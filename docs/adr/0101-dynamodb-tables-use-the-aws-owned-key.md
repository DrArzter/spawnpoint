# ADR-0101 — DynamoDB tables use the AWS owned key

- Status: Accepted
- Date: 2026-11-25
- Milestone: M6

## Context

The four DynamoDB tables (`spawnpoint-lifecycle-v2`, `spawnpoint-access`, `spawnpoint-control-plane-view`,
`spawnpoint-release-refs`) were encrypted with the AWS managed key `aws/dynamodb`. DynamoDB asks KMS for the table key
about every five minutes for each caller, so the request count follows the number of warm Lambda containers. In
CloudTrail on 24-25 November 2026 these calls were 77% of the account's KMS requests, and the account passed 85% of
the 20,000 free KMS requests a month.

The AWS managed key gives no control this project uses: its policy and rotation belong to AWS. What it adds is a
CloudTrail record of each use of the key.

## Decision

- Every DynamoDB table is encrypted at rest with the AWS owned key: `server_side_encryption { enabled = false }`.
  The data stays encrypted with AES-256; only the key's owner changes.
- The Terraform tests assert the owned key, so a table does not return to the managed key unnoticed.

## Consequences

- DynamoDB makes no KMS request. The remaining requests come from Lambda environment decryption and Parameter Store
  SecureString reads.
- CloudTrail no longer records the table key's use. Who may read the data is still decided by IAM.
- The change is made in place by `UpdateTable`; the tables stay available.
- A table that must later hold data under a key the owner controls uses a customer managed key, with its own cost.
