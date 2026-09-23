# ADR-0050 — Join as Viewer through any login provider, and ask for more

- Status: Proposed
- Date: 2026-09-16
- Revised: 2026-09-23 after the invited-mailbox proof and email-free deployment requirements were clarified
- Milestone: M4
- Amends: [ADR-0036](0036-observed-visitors-and-owner-approved-access.md)
- Relates: [ADR-0045](0045-provider-neutral-login-sessions.md), [ADR-0055](0055-sign-in-with-email-and-password-by-default.md), and [ADR-0057](0057-link-login-providers-through-the-current-identity.md)

## Context

Owner approval currently decides whether an authenticated account becomes a Spawnpoint Identity at all. Yet the
built-in `viewer` role holds only `status.read`, and the permission-filtered control-plane response withholds
connections, releases, infrastructure and every state-changing operation.

The right to join Spawnpoint and the way a person proves a login account are separate decisions. Binding an invitation
to Telegram, Google or Discord would force the sender to choose the recipient's provider. Addressing it to an email
instead identifies the intended recipient without making a login provider part of authorization. The existing “let's play this world” feature is a targeted
notification to identities that already have access; it grants nothing and is not this invitation.

## Decision

An Owner creates a single-use, expiring **Access invitation** to one Spawnpoint deployment. When email delivery is configured, it is addressed to one email; in an email-free deployment, the Owner shares its one-time link directly. Its URL opens one joining
surface offering every login provider enabled there. The recipient chooses Telegram, Google, Discord, email and
password, or a future provider. Provider-specific verification returns a provider-neutral principal; consuming the
invitation atomically creates one Identity with the configured default role, `viewer`, and links that principal as its
first account.

In email-enabled deployments the Access invitation is bound to the invited email, but not to a provider subject. A password account can consume it only when its verified email matches. Providers without a trustworthy verified email, such as Telegram, also complete a fresh mailbox proof sent to the invited address after signing in; the proof is bound to that login account and the invitation. Possessing the invitation URL alone is insufficient in this mode. In email-free deployments the link is the bearer invitation and a verified login-provider identity is the second requirement. Exactly one attempt wins. A provider account
already linked elsewhere is refused without consuming the invitation, and concurrent choices cannot create two
identities. The first linked account is not primary; the person may add others later through ADR-0057 without changing
their role.

Unknown accounts without a valid Access invitation do not create an Identity. Existing linked accounts continue to
sign in normally, and the bootstrap Owner remains the one deployment-setup exception.

After joining, requesting more access means requesting a target role or named permissions with a reason. Approval
changes the existing Identity's role or direct grants; it does not create another Identity. Blocking is an explicit
Identity state that signing in or linking another provider never clears.

## Consequences

- An email-addressed invitation grants entry to the verified mailbox holder; an email-free deployment can still invite through a one-time link. The recipient, not the inviter, chooses authentication.
- Every joined person immediately gets the deliberately narrow Viewer surface.
- Owner attention is reserved for privilege elevation rather than routine entry.
- Public password registration can close once Access invitations ship without making password a lesser provider.
- Targeted play notifications remain ordinary notifications and never affect permissions.
- Implementation needs durable invitation tokens, atomic consume-and-create, elevation requests and a blocked state.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Create a Viewer after any unknown account signs in | Turns an open password form into an unbounded Identity factory and records no decision to invite the person |
| Bind an invitation to one provider | Forces the inviter to choose the login method and excludes providers without email |
| Share an invitation without proving the invited mailbox | Anyone with an intercepted URL could register another account and consume it |
| Keep approval before Viewer | Spends Owner attention to protect only coarse status that is already safe to publish |
| Treat a “let's play” notification as an access grant | Couples communication to authorization and surprises both sender and recipient |
