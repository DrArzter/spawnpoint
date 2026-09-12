# ADR-0043 — Deploy production from reviewed pull requests through OIDC roles

- Status: Accepted
- Date: 2026-09-12 — records a decision already implemented in `ea546ee` and `b6cd30b`, written down after the fact so
  the placeholder in [the index](README.md#decisions-still-to-record) stops describing it as open
- Amended by: [ADR-0044](0044-apply-github-identities-behind-an-owner-gate.md) — the GitHub identities root is applied
  by a gated identity job rather than by hand
- Relates: [ADR-0011](0011-terraform-for-infrastructure.md) (Terraform owns resources),
  [ADR-0028](0028-update-proposals.md) (GitHub as a thin OIDC client of AWS), [ADR-0025](0025-step-functions-for-long-operations.md)

## Context

Since 2026-08-31 `.github/workflows/check.yml` has run `scripts/check.sh` on every push and pull request with
`contents: read` and no cloud identity: links, shellcheck, the node tests, the containerised server suite, the panel
build, and `fmt` plus `test` across every Terraform root. That answered the credential-free half of "CI for
infrastructure". Applying the result to AWS still happened from an owner workstation: a saved plan per root, reviewed
by eye, applied by hand, recorded in a command log.

That worked for one operator applying four roots a few times a month. It stopped working when the roots became eleven
and the change rate became several commits a day: the apply lagged the merge, so `main` described a system that was not
yet the one running, and the order between roots — host before operations, operations before bot — lived in people's
heads. A change that passed every local rung could still be applied late, applied out of order, or not applied at all.

The mechanism was already decided in [ADR-0028](0028-update-proposals.md): GitHub assumes an AWS role through its OIDC
provider, receives temporary STS credentials, and stores no access key. A deployment role is that mechanism with wider
permissions — which is precisely why it deserved its own record rather than an extension of the release role.

## Decision

**Production is deployed by GitHub Actions from `main`, only after `Check` has passed, through three deliberately
separate OIDC identities owned by `infra/terraform-github`.**

| Identity | Trusted by | May |
| --- | --- | --- |
| `spawnpoint-github-release` | each game's configuration repository, on `main` | start the fixed `spawnpoint-build-release` and preset-catalog workflows and inspect their executions — nothing else |
| `spawnpoint-github-deploy` | this repository's `production` environment only | the read, create and update calls the current Terraform resources need; IAM management limited to `spawnpoint-*` identities; deletion only of Terraform state locks and obsolete static web assets; an explicit deny on changing itself |
| `spawnpoint-github-plan` | this repository's owner-reviewed `production-plan` environment only | read Terraform state and infrastructure metadata; it cannot write a state lock, mutate AWS or apply |

**The tested diff is classified, and only the changed units are deployed.** On a push to `main`, `Check` runs
`scripts/deployment_plan.py` over the tested commit range and publishes the result as an artefact: which Terraform
roots changed (a workflow definition maps to the root that renders it; a `server/` change re-plans the host and release
roots), whether Lambda bundles or the web build changed, and what needs a human. `Deploy production` runs when that
`Check` succeeds, downloads the plan, and applies in order: infrastructure, then Lambdas, then web. Terraform applies go
through `scripts/terraform-apply-safe.sh`, which **refuses any delete or replacement the root's `destroy-allowed.txt`
does not name** (see below); Lambdas
through `scripts/deploy-lambdas.sh`, which updates only functions whose bundle hash changed; the web build through
`scripts/deploy-web.sh`, which skips an unchanged `index.html`.

**Two roots are never auto-applied.** `infra/terraform-bootstrap` keeps local state by construction.
`infra/terraform-github` is the identity itself: the deployment role must not be able to edit its own trust or
permissions, so a change there is reported as manual work, and after an owner applies it the workflow assumes the
read-only plan role and requires a fresh zero-change plan (`scripts/terraform-verify-applied.sh`) before it considers the
step complete. Manual work that cannot be verified that way — a `server/user-data.sh` change, or a missing previous
commit — fails the workflow rather than being assumed done.

**A pull request receives a read-only production plan.** `terraform-plan.yml` runs in the `production-plan`
environment, so an owner approves the gate before any pull-request code holds the state-reading role or the Terraform
inputs. It plans only the affected roots through `scripts/terraform-plan-safe.sh`, fails on deletes or replacements the root
does not allow-list, and
reports per-root add/change/delete/read counts in one marker-owned comment; `Check` reports the passed and failed rungs
in another. Reruns update those comments instead of adding noise.

**`main` is protected**: one approving review, stale-review dismissal, last-pusher separation, and both status checks
required — `scripts/check.sh` and `Terraform production plan` — for administrators too. The configuration is prescribed
in [infra/terraform-github/README.md](../../infra/terraform-github/README.md); verify it against the repository
settings rather than this record.

**Secrets stay in AWS and in GitHub environments, never in the repository.** `TF_VAR_*` inputs are environment
secrets; the CurseForge key never leaves Parameter Store; there are no AWS access keys to store or rotate.

## Consequences

**Good**

- `main` and production converge on their own, in the order the roots require, within minutes of a merge.
- The blast radius of a bad merge is bounded by what the deploy role may do and by the refusal of deletes and
  replacements: the host, its volume and the buckets cannot be destroyed by a pipeline run.
- A reviewer sees the real production diff — counts per root — before approving, without holding credentials.
- The command logs stop being the only record of what was applied; the workflow run is.

**Bad, or risky**

- Two more IAM roles with real authority exist in the account. Their trust is pinned to exact repository and environment
  subjects, and the plan role is read-only, but they are worth the same audit attention as the release role.
- The classifier is a list of path rules. A new root or a new workflow file must be added to
  `scripts/deployment_plan.py`, or its change is silently not deployed; the tests in `scripts/tests/` guard the rules
  that exist, not the ones nobody wrote.
- **The host's checkout under `/srv/spawnpoint/app` is outside this pipeline.** A `server/` change re-plans Terraform
  but does not reach the instance; the host copy is refreshed by an explicit SSM step, and any change to a host-side
  contract must land there before the machine that depends on it is applied. The runbook records the order per
  contract; this pipeline does not enforce it.
- A refused delete or replacement is the right default and also a wall. The wall has one door, for control-plane wiring
  only: the root names the exact resource address in its `destroy-allowed.txt`, in the same pull request, and the deploy
  identity holds exactly the delete actions those thirteen types need — see *Allowing a destroy* in
  [scripts/README.md](../../scripts/README.md#allowing-a-destroy). Anything that carries state or is registered outside
  the account — the host, its volume, the buckets, the tables, the OIDC trust, the distribution, the bot's Function URL,
  the guardrails, the GitHub identities — can be listed by nobody and deleted by no pipeline run; that is still an owner
  apply from a workstation, recorded in a command log, not a merge.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep applying from the owner workstation | Worked at four roots and a few commits a month. At eleven roots and several commits a day the apply lagged the merge, and the inter-root order lived in nobody's file |
| One broad deploy role with `AdministratorAccess` | Simplest to write. Would let a pipeline run destroy the buckets and the host, and let pull-request code edit its own trust; the enumerated policy plus the refusal of deletes is what makes an automated apply acceptable |
| Terraform Cloud, Spacelift or Atlantis | The plan-approve-apply interaction is exactly right and is borrowed. The platforms hold apply-rights credentials to the account — a third party with write access this project keeps declining — and solve multi-operator problems one operator does not have. See [docs/prior-art.md](../prior-art.md) |
| Long-lived AWS access keys as GitHub secrets | Nothing to rotate is better than a rotation schedule; OIDC was already the mechanism for the release role |
| Deploy every root on every push | Simpler classifier. Plans eleven roots for a README change, and re-plans the host for every unrelated commit, which is how a stale local module or a provider upgrade becomes a surprise replacement |
