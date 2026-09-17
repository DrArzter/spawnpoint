# ADR-0055 — Sign in with email and password by default, and with a provider as an alternative

- Status: Accepted — implemented in the same change, 2026-09-17
- Date: 2026-09-17
- Milestone: M4
- Extends: [ADR-0045](0045-provider-neutral-login-sessions.md), which made a login session independent of the provider
  that produced it and named email and password as an adapter an installation might add. This is that adapter, and
  the first that is not a chat platform
- Relates: [ADR-0036](0036-observed-visitors-and-owner-approved-access.md) (approval still decides what an account may
  do), [ADR-0020](0020-email-channel.md) (no SES, so nothing is sent to an address),
  [ADR-0043](0043-deploy-production-from-reviewed-pull-requests.md) (the two routes this replaces are destroyed through
  its allow-list), [ADR-0050](0050-default-role-on-sign-in-and-elevation-requests.md) (which changes what a fresh sign-in
  is worth, and therefore what open registration is worth)

## Context

Telegram is the only way into the panel. [ADR-0045](0045-provider-neutral-login-sessions.md) separated the session
from the provider — every adapter produces one `LoginPrincipal`, every principal gets the same 15-minute token and
30-day refresh credential — and said that email and password, Google or Discord could join later without touching
that core. None joined. A person with no Telegram account, or one who will not hand a Telegram account to a hobby
service, has no way in.

The owner's requirement, recorded on 2026-09-17: the classic form — email and password — is the **default** way in,
and every other provider is a button beside it. The same form must create an account and sign into an existing one.

Two facts decide what an email address can mean here. [ADR-0020](0020-email-channel.md) chose no SES until
something needed it, and nothing sends mail today; a sender is a project of its own — sandbox exit, DKIM, SPF, DMARC
and a reputation to earn. And [ADR-0036](0036-observed-visitors-and-owner-approved-access.md) keeps approval as the
gate: signing in produces an access candidate with no permissions, and an Owner turns it into an Identity with a
role. Authentication has never granted anything, and does not start to now.

One more: the panel's approval queue addressed a candidate by Telegram id, in the route key itself
(`/access/candidates/{telegramId}/approve`). It could not approve anything else.

## Decision

**A second login adapter, `password`, and the panel drawn around it.**

**The credential.** An email address, a display name and a salted password hash, keyed by the normalized address
in the access table. Its subject — what the principal, the account item and the session name — is the credential's
own uuid, never the address, so an address can be corrected or verified later without the identity behind it
changing. Normalization is one spelling per mailbox: trimmed, lower-cased, one `@`, a dotted domain.

**The password.** Hashed with scrypt, `N = 2^15, r = 8, p = 1`, a random 16-byte salt, the text NFKC-normalized so
one passphrase typed through two keyboards is one passphrase. The parameters are stored beside the hash, so raising
them is a new hash and not a migration. The only rule is length, 12 to 128 characters; composition rules push people
towards predictable substitutions and neither NCSC nor NIST recommend them. Ten wrong guesses lock the address for
fifteen minutes. A guess against an address nobody registered, or a locked one, is verified against a decoy hash, so
the time a refusal takes does not say whether the address exists, and every refusal is the same `401`.

**The address is a sign-in name, not a verified channel.** Nothing is sent to it, and the panel lists it as
unverified wherever it lists links. Verification arrives with a sender — ADR-0020's most likely trigger has now
fired — and not before.

**Registration is public and grants nothing.** `POST /auth/password/register` creates the credential and a login
session in one step. The account it signs in as is observed like any other and holds no role until an Owner grants
one. A taken address is refused as such: on the registration path a person is asking about their own address, and the
alternative is a form that silently does nothing.

**A deployment says which ways in it offers.** `GET /auth/providers` is public and lists the adapters the deployment
routes. Email and password is a deployment switch, `password_login_enabled`, on by default; off, its routes answer as
if they had never been deployed, so the panel reads them as not connected rather than broken
([ADR-0053](0053-tell-not-built-apart-from-broken.md)). Telegram's button is drawn only when the API offers Telegram
and the build knows the public client id.

**The form is the default; providers are alternatives.** The front door's **Sign in** opens one panel, and the
console's sign-in card renders the same panel: the email-and-password form, then *or*, then one button per other
provider. One form both creates an account and signs into one — a toggle changes the fields and the verb, nothing
else. A person who registers lands on the same request-access card a Telegram visitor lands on.

**A candidate is addressed by platform and account id.** `POST /access/candidates/{platform}/{platformUserId}/approve`
and `…/dismiss`. Approval links whichever account was observed; the decision notification goes to Telegram only when
the account is one. The Telegram-only routes are removed, named in the root's `destroy-allowed.txt` as ADR-0043
requires.

**A principal carries an optional email** beside its username, and the session reports the account's provider, its
platform id, and its email or Telegram id. Every consumer that assumed a Telegram id — the profile, the owner
bootstrap card, the visitor card — now reads the provider first.

## Consequences

**Good**

- Anybody the owner approves can play without a Telegram account, and without handing one to Spawnpoint.
- ADR-0045's claim is tested by a second adapter: tokens, refresh, revocation, linking and authorization did not
  change. A third adapter is a provider file and a row in the provider list.
- The approval queue treats accounts uniformly. Google or Discord, if ever added, is a candidate like any other.
- The default way in is the one every person already knows how to use.

**Bad, or risky**

- Spawnpoint now holds a secret people can forget, and there is no reset path, because there is no channel to send
  one through. Today the way back is the owner deleting the credential and the person registering again.
- An unverified address is a claim. A person can register any address they like; nothing is sent to it, so nothing
  is spoofed, but the owner reviewing the queue sees a claim and must know it is one.
- Open registration is a public endpoint that does one scrypt per call. Abuse costs Lambda time and fills the queue
  with junk. It grants nothing, and it is not rate-limited by anything but API Gateway's stage.
- Under ADR-0050 a fresh sign-in would be worth the default role. That decision rests on the friction of handing over
  a personal account deterring casual arrivals; a form has no such friction. Open registration and a default role
  cannot both stand as written.
- The lockout is by address, so somebody who knows an address can lock its owner out for fifteen minutes at a time.

**Mitigations**

- Approval is the gate, so registration widens nothing an anonymous person can do. This is why it can be public at
  all.
- The switch is per deployment. If abuse appears, stage throttling in `infra/terraform-access-api` bounds it without a
  domain change; an invitation code at registration is the next step and is ADR-0019's mechanism.
- The decoy hash and the uniform refusal keep an address's existence private on the login path, which is the path an
  attacker uses.
- ADR-0050 must decide registration before it lands: an invitation code, or a default role that self-registered
  accounts do not receive. Recorded here so it is not rediscovered as an incident.
- The credential's subject is a uuid, so the eventual reset and verification flows change the record, not the
  identity.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Cognito's hosted sign-in | The managed dependency ADR-0045 declined, and it brings its own sender and its own session format. Everything it would replace is a few hundred lines that are already tested |
| Magic links by email, no password | Needs a sender, which is exactly what ADR-0020 deferred. Reconsider as an addition when SES lands |
| Google or Discord OAuth as the default | Buttons, not the form the owner asked for, and each still leaves out anybody without an account at that provider. Both remain the alternatives this decision makes room for |
| Owner-created accounts with a handed-over password | No public registration to abuse, but more owner work, and passwords travelling through chat. The queue already gives the owner the decision without the typing |
| Argon2id | The better algorithm on paper. Node ships scrypt with no native dependency, and the parameters chosen meet the current OWASP minimum for it; the format stores its parameters so a change of algorithm is a new prefix |
| Verify the address before allowing sign-in | The right end state. Impossible without a sender, and an unverified account can do nothing until an Owner acts on it |

## Open questions

- Password reset. Needs a delivery channel (SES per ADR-0020) or an owner-issued one-time code (ADR-0019's shape).
  Until then re-registration creates a new identity; attaching a new credential to an existing identity is account
  linking and belongs with ADR-0019.
- Whether an unverified account should be approvable at all once a sender exists, or whether verification becomes a
  precondition of approval.
- Whether registration should require an invitation code before ADR-0050 is implemented, rather than as part of it.
- A show-password control and a breached-password check in the form. Both are form work; neither changes the
  contract.
