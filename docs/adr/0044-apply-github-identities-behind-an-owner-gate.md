# ADR-0044 — Apply the GitHub identities from the pipeline, behind an owner gate

- Status: Accepted
- Date: 2026-09-12
- Amends: [ADR-0043](0043-deploy-production-from-reviewed-pull-requests.md) — its "never auto-applied" root gains an
  applier of its own

## Context

ADR-0043 kept `infra/terraform-github` — the root that defines the pipeline's deploy and plan identities — out of the
pipeline on purpose: an identity that can apply its own definition can grant itself anything, and with no second
reviewer on a one-person repository nothing would stand between a merged pull request and an escalated deploy role.
The deploy identity is denied from touching itself at IAM, and the owner applied the root from a workstation.

The cost arrived on the first day the pipeline carried real changes. The plan identity lacked two permissions the
provider needs during a plan, and the allow-list for destroys needed delete actions on the deploy identity; each was
a change to the one root the pipeline may not apply, so each needed a workstation with the `spawnpoint` profile —
which this machine does not have. Two hand applies in one evening for a root whose changes are the pipeline's own
prerequisites is the wrong shape: the pipeline was waiting on a human for work the pipeline had generated.

## Decision

**A fourth identity applies the GitHub identities, and nothing can apply that identity but a hand.**

`spawnpoint-github-identity-admin` lives in its own root, `infra/terraform-identity-admin`, which is applied by hand
and changes only if the repository identity or the environment name changes — that is, never. The role may create and
update the `spawnpoint-github-*` roles, their inline policies and the OIDC provider, and may read and write only the
GitHub identities' own state object and lock. It may delete nothing: retiring an identity stays a hand apply. It is
denied from touching itself, and the deploy identity is denied from touching it, so no pipeline run can reach the
role that changes the identities.

Its trust is one OIDC subject: this repository's `production-identity` environment, whose required reviewer is the
owner. `Deploy production` gains an `identity` job that runs when the tested diff touched `infra/terraform-github`,
waits at that gate, assumes the role and runs the same `terraform-apply-safe.sh` as every other root — so a delete or
replacement is refused there too — and runs before infrastructure, Lambdas and web, which may depend on the new
permissions. The pull-request plan of that root is unchanged: the read-only plan identity reports it, and the owner
reads the IAM diff in the pull request.

The human step therefore moves from a workstation to a gate: the owner still approves every change to the pipeline's
own permissions, having reviewed the diff, but approves it where the rest of the pipeline already asks — and nothing
in the pipeline can widen its own reach without that approval.

## Consequences

**Good**

- A change to the pipeline's permissions ships like any other change: pull request, plan, merge, one approval.
- The anchor is tiny, has no reason to change, and is unreachable from every automated identity.
- The identity job is additive by construction — no delete permission, no allow-list — so the worst a mistaken
  approval can do is grant a permission, which the next pull request can revoke the same way.

**Bad, or risky**

- One more IAM role with real authority, and one more environment to keep gated. If the required reviewer is ever
  removed from `production-identity`, any merged pull request can change the deploy identity's permissions; the gate is
  load-bearing and belongs in the same audit as the roles.
- The owner approves the gate having read the pull request's IAM diff as code; the job does not show the plan before
  the approval. The apply-safe script refuses destroys, but an over-broad allow statement reads as an update.
- The anchor root still needs one hand apply, the last one, and its state key needs a lock-cleanup rule in
  `terraform-bootstrap`, which is also applied by hand.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep the root hand-applied | The correct principle at the wrong grain: the pipeline generated the changes it then waited on a workstation for |
| Remove the deploy identity's self-deny and let it apply the root | One line. A merged pull request — on a repository where merges are the owner's bypass and agents author pull requests — could then grant the pipeline anything, silently |
| Put the anchor role in `terraform-bootstrap` | Same trust property, but bootstrap keeps local state on one machine and exists for the state bucket; a role there would be managed from a state file that must not be lost, for a purpose the root does not have |
| A gate on the plan job instead of a separate identity | Changes nothing: the plan identity is read-only and the deploy identity still could not apply the root |
