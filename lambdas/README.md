# lambdas

Every piece of code that is not the game server and not the panel. Four groups, kept separate because they
fail for different reasons and have different permissions.

| Group | Functions | Notes |
| --- | --- | --- |
| Control plane | start, status, releases, promote, backups, restore, logs, link, unlink | The only code allowed to change state. Owns every authorisation rule. See [ADR-0012](../docs/adr/0012-web-control-panel.md) and [ADR-0019](../docs/adr/0019-account-linking.md) |
| Lifecycle | idle check, Spot interruption handler, post-session backup | Scheduled or event-driven. No public surface |
| Pipeline | release validation, mod reconciliation, health check, client pack build | Triggered by a promotion. See [ADR-0009](../docs/adr/0009-s3-as-mod-source-of-truth.md) |
| Adapters | Discord interactions, Telegram webhook, event fan-out to both | Verify every request. Never trust the identity in the payload unverified. A bot also issues sign-in links, so these are security-relevant. See [ADR-0016](../docs/adr/0016-chat-integrations.md) and [ADR-0021](../docs/adr/0021-sign-in-from-linked-chat-account.md) |
| Auth | Cognito custom authentication triggers for the bot-issued sign-in link | Verifies one thing: is this token present, unused and unexpired. Keep it that small |

Rules that apply to all of them:

- One IAM role per function, scoped to what that function actually does. No shared "lambda role".
- Reach the instance through SSM Run Command only. No SSH, no VPC attachment, no key material. See
  [ADR-0007](../docs/adr/0007-ssm-instead-of-ssh.md).
- Secrets come from SSM Parameter Store at runtime, never from environment variables in Terraform.
- Anything slow is an operation with observable state, not a long request.

Runtime not yet chosen. Whatever it is, it should be the same across all four groups.

**Status:** empty. Lifecycle functions arrive in M2, pipeline in M3, control plane and adapters in M4.
