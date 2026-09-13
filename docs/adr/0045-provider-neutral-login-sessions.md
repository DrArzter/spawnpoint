# ADR-0045 — Keep login sessions independent of identity providers

- Status: Accepted
- Date: 2026-09-13
- Milestone: M4
- Supersedes: [ADR-0037](0037-telegram-only-browser-identity.md)

## Context

Telegram is the first deployed sign-in method, but an installation may later offer email and password, Google or Discord without requiring any of them. A person may also link several external accounts to one Spawnpoint identity. Treating a Telegram ID as the subject of every token or using the bot token to sign Spawnpoint sessions would make Telegram part of the authentication core rather than one adapter.

A bearer token persisted in browser storage survives restarts but is readable by any script executing on the origin and cannot be individually revoked without state. Requiring a fresh Telegram popup on every page visit avoids that persistence at the cost of a poor browser experience.

## Decision

Every sign-in adapter produces a `LoginPrincipal` consisting of a provider, that provider's stable subject and presentation fields. A principal authenticates a revocable login session; separately, linked-account resolution maps it to at most one Spawnpoint `Identity` and its permissions.

The API issues a 15-minute signed access token kept only in JavaScript memory and a rotating opaque refresh credential in a `Secure`, `HttpOnly` cookie with a 30-day absolute lifetime. DynamoDB stores the credential hash, principal, expiry and revocation state with TTL cleanup. Access tokens use a provider-neutral signing secret, not a provider credential. Telegram remains the default built-in adapter and the bootstrap Owner path for now; future adapters are optional capabilities, not installation requirements.

Production serves the API from a repository-configured subdomain under the panel's site so the refresh cookie can be `SameSite=Strict`. A self-hosted installation may retain the generated API endpoint and a `SameSite=None` cookie without owning a domain.

## Consequences

**Good**

- Adding or removing an identity provider does not change token, refresh, revocation or authorization semantics.
- Reloads and browser restarts usually need no provider login, while scripts cannot read the long-lived credential.
- One person can later link several provider accounts to one internal identity.
- Individual login sessions can be revoked and expire independently.

**Bad, or risky**

- Refresh is stateful and adds DynamoDB reads, conditional rotations and cross-origin cookie configuration.
- Simultaneous tabs may race while rotating one shared cookie; clients must retry once with the newest cookie.
- The custom API hostname adds an ACM certificate and Route53 records to production.

**Mitigations**

- Conditional writes prevent two callers from successfully reusing the same refresh credential.
- CORS allows credentials only from configured panel origins.
- Legacy tab-scoped Telegram tokens remain verifiable only for their existing short lifetime during rollout.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Persist one long-lived bearer token in local storage | Readable by origin scripts, not naturally rotated, and not individually revocable |
| Require Telegram on every browser restart | Secure but needlessly repetitive, and couples the whole product experience to one adapter |
| Make Telegram ID the internal user key | Prevents clean account linking and makes every future provider a migration |
| Add Cognito now | Adds a mandatory hosted dependency before another provider or managed account store is actually needed |
