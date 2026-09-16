# ADR-0050 — Grant the default role on sign-in, and let people ask for more

- Status: Proposed
- Date: 2026-09-16
- Milestone: M4
- Amends: [ADR-0036](0036-observed-visitors-and-owner-approved-access.md), which keeps its permission model, its
  four built-in roles and its owner-reviewed queue, and loses the visitor as a separate class of person
- Relates: [ADR-0045](0045-provider-neutral-login-sessions.md) (authentication is a provider-neutral session, and
  this decision is written in those terms), [ADR-0018](0018-identity-and-sign-in.md) (the Identity this grants)

## Context

ADR-0036 made approval the gate: signing in observes an **access candidate**, and an Owner turns that candidate into
an Identity with a role. Merely arriving grants nothing.

Three facts have changed since, and together they move where the gate should sit.

**Authority is no longer positional.** `lambdas/src/handlers/access-api.ts` declares one access level per route in a
single table and denies by default; `lambdas/test/access-api-routing.test.ts` pins that table against the routes
Terraform deploys and forces every route to be permission-checked or listed as deliberately self-scoped. Eight routes
are on that list today: the three auth routes, `GET /session`, `POST /access/request`, `GET /me`, and the caller's own
notification subscriptions. Every one of them reads or writes only the caller's own record.

**The default role is nearly empty.** `viewer` holds exactly one permission, `status.read`, and exactly two routes
require it: `GET /control-plane` and its WebSocket subscription. The control-plane snapshot already redacts by
permission — infrastructure needs `access.manage`, the desired release needs `release.read`, and the address host is
withheld from a caller without `connection.read`.

So a person who is authenticated but unapproved already reaches those eight self-scoped routes. Granting them the
default role widens the surface by one thing: world names and coarse state, without addresses, releases or
infrastructure. That is the same surface a public status page is free to publish.

**The gate costs the group more than it saves.** It stops nobody who matters — a stranger has to want in, and wanting
in means handing over a personal account on an identity provider to a service they have never heard of. What it does
reliably is interrupt the owner for every real friend, and leave that friend looking at a panel that shows nothing
until somebody is at a keyboard.

Assumption, recorded because the decision rests on it: the deployment is not advertised, and the friction of signing
in with a personal account deters casual arrivals. This holds until the link travels — a forward into another chat,
a link from the status page, an indexed page. It is a condition, not a control, which is why the cost of being wrong
is kept bounded below rather than assumed away.

## Decision

A successful sign-in through any provider creates an Identity holding the role named by deployment configuration,
default `viewer`, unless that subject is **blocked**. The visitor and the access candidate stop being a separate class
of person: there is one kind of authenticated subject, and it has a role.

`POST /access/request` stops meaning "let me in" and starts meaning "give me more": a target role, or named
permissions, with a reason. An identity with `access.manage` approves or declines it. Approval is the same operation
the queue performs today — it assigns a role, or adds to the `directGrants` the Identity already carries.

**Blocking is an explicit identity state, and signing in never clears it.** Removing somebody used to be deleting
their Identity; under automatic provisioning that does nothing, because the next sign-in recreates it.

## Consequences

**Good**

- Onboarding is zero-touch. A new person sees the console immediately, at the surface a status page could publish.
- One class of user, so one code path. The visitor branch disappears from the panel, the bot and `GET /session`.
- The owner is interrupted only when somebody wants something, and the request carries intent and a reason instead of
  the fact that a stranger pressed a button.
- Direct grants become useful: asking for one permission no longer requires promotion to a whole role.

**Bad, or risky**

- The default role's permission set becomes the surface every authenticated person holds. Adding a permission to
  `viewer` later would be a public change that does not look like one in review.
- Removal now depends entirely on `blocked` being correct. A bug there is not a degraded control, it is no control.
- The access store gains a row per person who ever signs in, including people who never play.

**Mitigations**

- The default role is configuration, not a constant, so a deployment can open wider or narrower without a code change.
- A test pins the default role's permissions, so widening them is a deliberate diff with a reviewer attached.
- The snapshot's per-permission redaction is the load-bearing control and stays as it is.
- `observe()` is an idempotent upsert keyed by the provider subject, so one subject can only ever hold one row.

**Deliberately not done: rate limiting.** Identity creation is already idempotent per subject, so the only thing to
limit is the arrival of new subjects, which is bounded by real people holding real accounts. A counter with a daily cap
was considered and rejected on a specific ground: when the cap is reached, sign-in would succeed while provisioning
failed, resurrecting the roleless state this ADR removes. If volume ever appears, the answer is stage throttling in
`infra/terraform-access-api`, which touches no domain code.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep the gate as ADR-0036 wrote it | Pays a manual approval for every friend to stop an arrival that has not happened and has little reason to |
| Keep the queue, auto-approve to the default role, notify the owner with a revoke action | Same end state, but the owner's attention pays for arrivals instead of the store paying for rows. Worth revisiting only if arrivals become a problem |
| Make the default surface public, with no sign-in at all | Conflates two questions. Whether coarse status is public is a separate decision, recorded below as open |
| Delete unused identities on a schedule | Retention for a handful of rows a year is cost without benefit. Reconsider if the row count ever justifies it |

## Open questions

- Should `status.read`'s surface be reachable with no session at all, now that a status page publishes the same facts?
  That would make the default role's only permission redundant and is a separate decision.
- What a blocked person sees. Silence invites retries; an explanation tells somebody unwelcome exactly what happened.
