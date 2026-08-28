# ADR-0035 — Bootstrap the first Owner through one verified Google identity

- Status: Proposed
- Date: 2026-08-27
- Milestone: M4
- Amends: [ADR-0018](0018-identity-and-sign-in.md), which did not define how the first privileged identity is established

## Context

Normal access management assumes an authorised Owner already exists. A fresh deployment has no identity that can
invite users, create roles, or grant permissions, so it needs a separate bootstrap path. That path is security
sensitive: "the first visitor wins" would let anybody who finds the panel claim the deployment, while manually
writing an Owner into DynamoDB is difficult to audit and easy to repeat incorrectly.

[ADR-0018](0018-identity-and-sign-in.md) already makes Google the only provider that may create a new identity.
[ADR-0019](0019-account-linking.md) and [ADR-0021](0021-sign-in-from-linked-chat-account.md) require Telegram and
Discord accounts to be linked to an existing identity before they can authenticate. Bootstrap must preserve those
boundaries.

## Decision

Terraform supplies one `bootstrap_owner_email`. The first successful Google sign-in with that exact, verified email
atomically creates the first identity with the built-in `Owner` role and consumes the bootstrap. No other provider
can claim it, and a consumed bootstrap can never run again.

The claim is one DynamoDB transaction: assert that the bootstrap marker is unclaimed, create the identity, and mark
the marker claimed with the identity ID and timestamp. The marker, not the continued presence or later removal of
the Terraform value, is the authority on whether bootstrap remains open.

After bootstrap, the Owner adds people through the ordinary invitation and access-management flows. Telegram,
Discord, game, and network accounts are linked to the Owner profile afterwards. Losing the last Owner does not reopen
bootstrap; recovery is a separate operator procedure with an audit record.

## Consequences

**Good**

- A fresh deployment has a deterministic, documented route to its first administrator.
- Finding the public panel is insufficient to become Owner.
- Bootstrap remains consistent with Google-only identity creation and the no-JIT rule for chat accounts.
- The atomic claim prevents two concurrent first sign-ins from creating two initial Owners.

**Bad, or risky**

- A typo in the configured email blocks initial setup until the deployment configuration is corrected.
- Access to the selected Google account is temporarily equivalent to access to an unclaimed deployment.
- Recovering from a lost last Owner requires an operator procedure rather than another normal sign-in.

**Mitigations**

- Require the Cognito claim `email_verified=true`, normalize the address before exact comparison, and never accept a
  browser-supplied email without validating the signed token.
- Keep the configured address out of public frontend configuration and show only a masked hint before sign-in.
- Record successful and rejected claim attempts in the audit trail.
- Document a narrow break-glass recovery command that names the identity explicitly and cannot reopen bootstrap.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| First visitor wins | No trusted binding to the operator; possession of the URL becomes administrator access |
| First Telegram or Discord user becomes Owner | Violates the existing no-JIT rule and makes a bot surface the root of trust |
| Terraform creates the user directly | The stable Cognito subject does not exist before first authentication, and provisioning application records from infrastructure couples two lifecycles |
| Manually write the first Owner to DynamoDB | Works as an emergency recovery mechanism, but is error-prone and unaudited as the normal installation path |

## Open questions

- Exact location and masking of `bootstrap_owner_email` in the Terraform roots.
- The break-glass recovery command and the approvals it requires.
