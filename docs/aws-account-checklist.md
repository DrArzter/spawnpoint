# Fresh AWS account checklist

Everything to do on a new AWS account before building anything, in order, with the traps that are only obvious once you
have hit them. Written while doing it on 2026-08-12.

The matching read-only API verification is documented in [AWS CLI checks](aws-cli-checks.md) and automated by
`scripts/audit-aws-bootstrap.sh`.

**Order matters in three places**, and they are marked. The rest can be reordered freely.

Recorded values for *this* account live in [the runbook](runbook.md#account-bootstrap). This file is the procedure.

## 1. Root hygiene — as root

- [x] **MFA on the root user.** Account menu → Security credentials.
- [x] **Check for root access keys and delete any.** A new account should have none.
- [x] **Activate IAM access to billing.** Account settings → *IAM user and role access to billing information* →
      Activate.

> ⚠️ **Order trap.** Only root can flip the billing toggle, and without it the administrative identity you are about to
> create cannot see Cost Explorer or create a budget — which is the next thing it needs to do. Do it before you stop
> using root.

## 2. An identity that is not root — as root

- [x] **Create an IAM group** (`admin`) with the `AdministratorAccess` policy. Attach nothing else: search results for
      "administratorAccess" include service-scoped variants that add nothing, and clutter makes a later permissions
      review harder.
- [x] **Create an IAM user**, named after the person rather than the role, with console access and a password.
- [x] **Put the user in the group.** Not policies attached directly — the habit transfers.
- [x] **No access key.** Console work needs none, and by the time a CLI is needed there is a better option.
- [x] **Sign in as that user and enable MFA on it.**
- [x] **Verify Billing is visible** under the new identity. If not, step 1's toggle was missed.

> ⚠️ **Do not enable IAM Identity Center on a fresh account.** It is the better long-term answer, but enabling it
> creates an AWS Organization, and that **upgrades the account off the free plan and expires the free tier credits
> immediately** — $100–200, roughly a year of running a small project. The console warns about this in a box that is
> easy to skim past.
>
> An *account instance* of Identity Center avoids the Organization but **cannot grant console access to AWS accounts**;
> it only serves AWS managed applications. So it is not a workaround.
>
> Do it later, alongside a move to the paid plan that is happening anyway.

## 3. Why not just use root

Two arguments survive on a one-person project. The company ones — separation of duties, attribution — mostly do not.

- **Compromise is terminal.** Leaked root credentials let somebody change the email, remove MFA and close the account,
  with no path back. A leaked IAM user is deleted by root.
- **Root bypasses your own guardrails.** Budget actions that deny APIs, permission boundaries, SCPs — root ignores
  them. Every control you build has a hole shaped exactly like root.

Root is kept, not deleted. It is needed for closing the account, the support plan, some billing settings, and enabling
Organizations later.

## 4. Cost guardrails

- [x] **A budget**: fixed, monthly, all services, unblended costs. Set it **above the modelled spend and well below a
      surprise** — a threshold that trips in a normal month gets muted, and takes the useful alert with it.
- [x] **Two alert thresholds**: one **forecasted**, one **actual**. Forecast catches a runaway days early; actual is
      the backstop.
- [x] **An SNS topic** for alerts, so every future alarm and the chat adapters converge on one place.
- [x] **Email subscription on the topic, confirmed via the link.** Unconfirmed means silently undelivered.
- [x] **Point the budget at the SNS topic too**, not only at email.
- [x] **Retune the cost anomaly subscription.** AWS pre-creates a monitor and a subscription, and the default threshold
      is `$100 AND 40%`.
- [ ] **A cost anomaly monitor** — already created by AWS as `Default-Services-Monitor`. Nothing to configure: the
      "AWS services" type covers everything automatically and has no per-service settings.

> ⚠️ **The default anomaly subscription cannot fire on a small account.** `$100 AND 40%` on an account whose entire
> monthly bill is ~$15 means the absolute condition is never met. It looks configured and does nothing, which is worse
> than absent. Lower it to a few dollars.

> ⚠️ **Individual anomaly alerts require SNS.** Email delivery only works for daily and weekly summaries.

> ⚠️ **An SNS topic needs a policy statement per publishing service**, because each is a different service principal:
> `costalerts.amazonaws.com` for anomaly detection, `budgets.amazonaws.com` for Budgets. Use the **Advanced** access
> policy, and include an `aws:SourceAccount` condition so the grant only applies to operations on behalf of this
> account. The Basic option cannot express a service principal.

### What is actually protecting you on day one

Fewer things than the console suggests. Both of these switch on by themselves once history accumulates:

| Guardrail | Live on a fresh account? |
| --- | --- |
| Budget, actual threshold | **Yes** |
| Budget, forecasted threshold | No — AWS cannot forecast an account with no history |
| Cost anomaly detection | No — needs roughly ten days to build a baseline |

So for the first weeks the only automatic guardrail is the actual-cost alert, which arrives *after* the money is spent.
Work out how long a mistake would take to reach that threshold, and treat the answer as the size of your attention
budget.

> ⚠️ **On a free plan with credits, verify the budget reports real numbers.** If credits net the reported cost to zero,
> the budget never fires. Check it shows something once a resource has run for a few hours, and filter the charge type
> if it does not.

## 5. Deferred deliberately

Not oversights. Each has a reason and a trigger.

| Item | Why not now | When |
| --- | --- | --- |
| IAM Identity Center | Expires the free tier credits | With the move to the paid plan |
| Budget **actions** — stop instances at a threshold | Nothing to stop yet, and it needs its own IAM role trusting `budgets.amazonaws.com`. It must attach to an **actual** threshold: an action on a forecast would stop a running server because the month was busy | Once there are instances, created by IaC and scoped to a tag |
| Tightening the SNS topic policy | The AWS default allows `AWS: "*"` scoped by source account, including `DeleteTopic` and `AddPermission`. Acceptable while personal, not least privilege | When IaC owns the topic |

## 6. Before the first resource exists

- [ ] **Pick one Availability Zone and write it down**, if anything zonal is coming. A volume binds to its zone and
      every later launch has to match.
- [ ] **Decide the tagging key** — a project tag on everything that costs money.
- [ ] **Activate the cost allocation tag** as soon as the first tagged resource exists.

> ⚠️ **Cost allocation tag activation is not retroactive.** Until it is activated in the billing console the tag does
> not exist in cost data, and the months before activation can never be given a breakdown.

> **Cost Explorer takes up to 24 hours** to prepare data on a new account. "Data unavailable" is normal, not a fault.

## 7. What to save outside AWS

| | |
| --- | --- |
| Account ID | |
| Console sign-in URL for the IAM user | |
| Root credentials and its MFA recovery | Somewhere separate from everyday storage |
| The IAM user's MFA recovery | |
| Alert topic ARN | |
| Chosen Availability Zone | |
| Budget threshold, and when to revisit it | |
| Account plan, and the date it must change | |

## 8. Console quirks worth knowing

- **Billing and Cost Management pages show region "Global"** and disable the region selector. That is correct — those
  services are not regional. Regional resources are created from their own consoles.
- **Instance-type prices are per region.** A price read in the wrong region is the wrong number, and the page gives no
  hint.
- **An ARN is `arn:aws:<service>:<region>:<account-id>:<resource>`.** Deterministic, so it can be written before the
  resource exists — useful when a policy has to reference the thing it is attached to.
