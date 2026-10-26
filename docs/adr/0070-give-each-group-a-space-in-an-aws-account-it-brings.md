# ADR-0070 — Give each group a space, and run its game hosts in an AWS account it brings

- Status: Proposed
- Date: 2026-10-26
- Milestone: M7 — spaces (new; not yet in the roadmap)
- Changes: the README non-goal "No multi-tenancy", when this record is accepted
- Relates: [ADR-0002](0002-host-on-aws.md), [ADR-0011](0011-terraform-for-infrastructure.md),
  [ADR-0040](0040-reusable-presets-and-world-wipes.md), [ADR-0054](0054-place-a-session-on-a-host-with-room.md),
  [ADR-0061](0061-connect-agents-through-oauth.md), [ADR-0065](0065-hand-out-world-files-as-short-lived-links.md)

## Context

The owner wants other groups to use Spawnpoint, as people use a public hosting panel. Today one install serves one
group:

- There is no tenant, organisation or space anywhere. Four built-in roles are global
  ([domain.ts](../../lambdas/src/access/domain.ts)); a person has one role.
- Everything that runs or stores a game assumes one AWS account and one region: the state machines, the release
  builder (CodeBuild), the EventBridge rules, the release and backup buckets, the lifecycle table and the one host
  role. Bucket names carry our account id, roots find each other by fixed names, and `eu-central-1` is enforced.
- The control plane calls AWS with its own default credentials (`lambdas/src/control-plane/aws.ts`). It has no STS
  code.
- Hosts never call the control plane. The control plane polls them through SSM and learns their state from
  same-account EC2 and Step Functions events.
- Presets live in our Git repository, reviewed by the owner (ADR-0040).

To host strangers' servers on our account is not acceptable: we would pay for every hour, run untrusted mods (Java
code) of several groups on shared hosts (ADR-0054), and carry abuse and DDoS risk.

Prior art: Pterodactyl is a panel that each group installs, with an agent on machines the group owns. Those machines
are always on. Our difference is that Spawnpoint starts a machine only when somebody plays.

## Decision

**A space is the unit of tenancy.** Games, worlds, presets, releases, roles, invitations, events and audit rows belong
to a space. A person keeps one identity and has a membership in each space they belong to; the membership carries a
role. The built-in roles keep their permissions, scoped to the space. The panel chooses the space with its scope
picker, and every route and MCP tool acts in one space.

**A space brings an AWS account.** Everything that runs or stores a game is one Terraform module, the *space stack*,
deployed into the space's account: network, launch template, host role, release and backup buckets, lifecycle table,
state machines, release builder, SSM documents and a budget alarm. The space pays AWS directly.

**The panel stack stays in our account:** API, access and view tables, web, bots, notifier and projector. It holds
identities, memberships and the projection. It does not hold worlds, archives or mods.

**The panel acts in a space through one role** that the space stack creates:

- it trusts only the panel's own roles, with the space id as the external id;
- it may start the space stack's state machines, send its SSM documents to its tagged hosts, read and sign links on
  its buckets and read its lifecycle table;
- it has no IAM rights and nothing account-wide.

The panel never holds a space's long-lived keys.

**Events come to the panel by forwarding.** The space stack forwards its EC2, Step Functions and CodeBuild events to
an event bus in our account. The bus accepts events only from connected accounts, and the panel finds the space by the
source account.

**Files stay in the space's account.** Packs, mods and world archives are stored in the space's buckets. Download
links are signed with the space role's credentials.

**Our group becomes the first space, in our account.** A self-hosted install is the same two stacks in one account,
so self-hosting stays possible with no separate code.

### Order of work

Each phase ships on its own and leaves production working.

1. Spaces in the control plane, with one space only (ours): keys gain the space, roles become memberships, the
   panel gains the scope picker. No AWS change.
2. The space stack: split the Terraform roots into the panel stack and the space stack; make the region, account and
   repository names variables.
3. Cross-account: the panel resolves a space's account and role for each request; the space stack forwards events.
4. Connecting a space, by invitation only: the space owner deploys the space stack with one command and gives the
   panel its role ARN; the panel checks the role and the stack version.
5. Presets per space: a space uses a catalogue or its own Git repository. Git stays the authoring path (ADR-0040).

Later, and not decided here: a machine outside AWS, registered with SSM as a hybrid managed node. It cannot be started
on demand.

## Consequences

**Good**

- We do not pay for other groups' compute. A space sees its cost and its budget alarm in its own account.
- Isolation is by AWS account: a mod in one space cannot reach another space's hosts, buckets or keys.
- Misuse of compute falls on the space's own bill and AWS terms, not on our account.
- The data-plane code stays single-account inside the space stack. The workflows do not change for cross-account
  use.
- The shared panel and a self-hosted install are one code base.

**Bad, or risky**

- Phase 1 touches nearly every record, key, route, MCP tool and screen. It is the largest change since M4.
- If the panel is compromised, the attacker can act in every connected account, inside the role's limits.
- To connect, a group needs an AWS account and must run Terraform. Fewer groups can join than with a free public
  host.
- Two stacks have versions. A space stack older than the panel must keep working, or the panel must refuse it.
- We still keep the identities of every member (email, Telegram id). Under UK GDPR we need a privacy notice, export and
  deletion.
- The Telegram bot, the game DNS zone and the ZeroTier network assume one group today.

**Mitigations**

- The external id per space prevents the confused-deputy problem. CloudTrail in the space's account records every
  panel action, and the space owner can read the role in the space stack.
- The space stack declares its version; the panel checks it when a space connects and before each operation.
- Joining is by invitation in phase 4; we approve each space.
- Phase 1 runs with one space until phase 3, under the existing contract tests and the breakpoint gate.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| We host every group's servers on our account | We pay for all compute, untrusted mods of several groups share hosts, and abuse and DDoS risk is ours |
| Self-hosting only | No tenancy work, but each group runs and updates its own panel and there is no shared identity. It stays possible as the one-account install |
| The panel's state machines drive the space's account remotely | Every task, document and IAM path crosses accounts, events still need forwarding, and a self-hosted install would differ from the shared panel |
| An agent on any machine, as Pterodactyl | No on-demand start: the machine runs, and is paid for, all the time. Kept as a later step |
| Accounts in our AWS Organization | We would own the accounts and pay the bills |

## Open questions

- CurseForge API key: one key for the panel, or one per space? The CurseForge API terms decide. Verify.
- How long does a link signed with assumed-role credentials stay valid? The role session bounds it. Verify against the
  900 s and 3600 s links (ADR-0065).
- DNS: does a space bring its own hosted zone, or does the panel write a name under our zone? Today hosts write their
  own records.
- Telegram bot: one bot for all spaces with a space chosen per chat, or one bot per space?
- ZeroTier: assumed to belong to the space, with its network id in the space's SSM parameters.
- Data protection: are we a processor for a space's world data, which stays in the space's account? This needs legal
  advice.
- Is the shared panel free, or does it have a price?
