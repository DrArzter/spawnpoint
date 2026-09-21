# ADR-0056 — Verify and link password credentials without making a provider primary

- Status: Accepted — implemented in the same change, 2026-09-21
- Date: 2026-09-21
- Milestone: M4
- Amends: [ADR-0055](0055-sign-in-with-email-and-password-by-default.md)
- Extends: [ADR-0045](0045-provider-neutral-login-sessions.md)

## Context

ADR-0055 deliberately shipped email as an unverified sign-in name because Spawnpoint had no transactional sender.
Resend is now available behind the optional email adapter. Keeping registration as an immediate login would let a
person claim somebody else's mailbox, while treating password credentials as a special kind of Identity would undo
the provider-neutral boundary: an Identity may begin with any login provider and later need another.

## Decision

An email address must be verified before its password credential can create a login session. Registration stores a
pending, unlinked credential and sends a one-time verification link; consuming that link creates the first session.
Verification and reset tokens expire, may be used once, and are stored only as hashes. Password-reset requests always
return the same accepted response whether or not the address exists.

Every enabled login provider produces a linked account of the same rank. An authenticated Identity may add an
email-and-password credential regardless of which linked account produced the current session. The new credential is
linked to that existing Identity before verification, but cannot sign in until its mailbox is proven. A current
password may be changed from any session after proving the old password; a reset link is the recovery path when it
is not known. Changing or resetting a password revokes the credential's existing refresh sessions.

Email delivery remains an adapter. A clone configured with `email_delivery_provider = "none"` still supports every
non-email login provider and existing verified password sign-in, but does not advertise registration, linking,
verification delivery or recovery. Sender identity, provider selection and secret parameter names come from
deployment variables; no domain, region, account id or sender is embedded in application code.

## Consequences

- Identity, permission and profile data survive adding or changing sign-in methods.
- A person cannot accidentally create a second Identity merely because they first arrived through another provider.
- Delivery failure can leave a pending credential, so verification can be requested again without recreating it.
- Existing credentials created before this decision must verify their mailbox before their next password sign-in.
