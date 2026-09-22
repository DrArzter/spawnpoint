# ADR-0057 — Link login providers through the current Identity

- Status: Accepted — implemented in the same change, 2026-09-22
- Date: 2026-09-22
- Milestone: M4
- Supersedes: [ADR-0019](0019-account-linking.md), whose one-time chat code assumed Google was the only browser login
- Extends: [ADR-0045](0045-provider-neutral-login-sessions.md) and [ADR-0056](0056-verify-and-link-password-credentials.md)

## Context

Spawnpoint already verifies Telegram OIDC to create a provider-neutral login session. Requiring a second `/link ABC123`
exchange would introduce another proof protocol for the same Telegram account, while signing into Telegram from an
email-created Identity without an explicit linking operation would create a second access candidate instead.

## Decision

A signed-in Identity may ask to add any proof-based login provider. The provider's existing adapter verifies its own
proof and returns a `LoginPrincipal`; one provider-neutral linking use-case atomically associates that stable provider
subject with the current Identity. It never chooses an Identity, changes a role, or merges two existing identities.

An account belongs to at most one Identity, and an Identity has at most one account from each login provider. A proof
already linked elsewhere returns a conflict. Password remains a specialized adapter because adding it creates a new
credential and requires mailbox verification, but it produces the same linked-account result. Google and Discord may
later join by supplying their verification adapters to the same linking use-case.

## Consequences

- Linking is symmetric: an email-created Identity can add Telegram just as a Telegram-created Identity can add a password.
- Linking grants no permission and cannot silently combine two people when providers disagree.
- Provider verification stays modular; DynamoDB keys, roles and Identity resolution remain outside every provider adapter.
- Unlinking still needs a separate decision because removing the last usable login method can strand an Identity.
