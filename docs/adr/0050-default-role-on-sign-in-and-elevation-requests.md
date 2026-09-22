# ADR-0050 — Join as Viewer through any login provider, and ask for more

- Status: Proposed
- Date: 2026-09-16
- Revised: 2026-09-22 after email registration exposed the provider-neutral invitation boundary
- Milestone: M4
- Amends: [ADR-0036](0036-observed-visitors-and-owner-approved-access.md)
- Relates: [ADR-0045](0045-provider-neutral-login-sessions.md), [ADR-0055](0055-sign-in-with-email-and-password-by-default.md), and [ADR-0057](0057-link-login-providers-through-the-current-identity.md)

## Context

Owner approval currently decides whether an authenticated account becomes a Spawnpoint Identity at all. Yet the
built-in `viewer` role holds only `status.read`, and the permission-filtered control-plane response withholds
connections, releases, infrastructure and every state-changing operation.

The right to join Spawnpoint and the way a person proves a login account are separate decisions. Binding an invitation
to Telegram, Google, Discord or an email address would force the sender to choose the recipient's provider and would
make provider data part of authorization. Meanwhile the existing “let's play this world” feature is a targeted
notification to identities that already have access; it grants nothing and is not this invitation.

## Decision

An Owner creates a single-use, expiring **Access invitation** to one Spawnpoint deployment. Its URL opens one joining
surface offering every login provider enabled there. The recipient chooses Telegram, Google, Discord, email and
password, or a future provider. Provider-specific verification returns a provider-neutral principal; consuming the
invitation atomically creates one Identity with the configured default role, `viewer`, and links that principal as its
first account.

The Access invitation is not bound to an email address or provider subject. Password enrollment consumes it only after
mailbox verification; OIDC providers consume it after their proof verifies. Exactly one attempt wins. A provider account
already linked elsewhere is refused without consuming the invitation, and concurrent choices cannot create two
identities. The first linked account is not primary; the person may add others later through ADR-0057 without changing
their role.

Unknown accounts without a valid Access invitation do not create an Identity. Existing linked accounts continue to
sign in normally, and the bootstrap Owner remains the one deployment-setup exception.

After joining, requesting more access means requesting a target role or named permissions with a reason. Approval
changes the existing Identity's role or direct grants; it does not create another Identity. Blocking is an explicit
Identity state that signing in or linking another provider never clears.

## Consequences

- The invitation grants entry; the recipient, not the inviter, chooses authentication.
- Every joined person immediately gets the deliberately narrow Viewer surface.
- Owner attention is reserved for privilege elevation rather than routine entry.
- Public password registration can close once Access invitations ship without making password a lesser provider.
- Targeted play notifications remain ordinary notifications and never affect permissions.
- Implementation needs durable invitation tokens, atomic consume-and-create, elevation requests and a blocked state.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Create a Viewer after any unknown account signs in | Turns an open password form into an unbounded Identity factory and records no decision to invite the person |
| Bind an invitation to one provider or email | Forces the inviter to choose the login method and excludes providers without email |
| Keep approval before Viewer | Spends Owner attention to protect only coarse status that is already safe to publish |
| Treat a “let's play” notification as an access grant | Couples communication to authorization and surprises both sender and recipient |
