# Run Spawnpoint in your own AWS account

One group, one AWS account, one fork of this repository. `scripts/onboard.sh` prepares the account and the fork;
GitHub Actions then deploys everything else, as it does here.

## You need

- An AWS account and an administrator sign-in that is not the root user.
- A public fork of this repository. Launched hosts clone it without a credential.
- A domain name whose DNS you control. Spawnpoint takes a subdomain of it, such as `play.example.com`, and moves that
  subdomain's zone to Route 53.
- `aws` (v2), `gh`, `terraform` 1.15 or later, `jq`, `openssl`, `python3` and `git`.

## Steps

```bash
git clone https://github.com/<you>/spawnpoint.git
cd spawnpoint
aws login
gh auth login
scripts/onboard.sh
```

Run `scripts/onboard.sh --dry-run` first to see what it would do. It changes nothing.

The script:

1. Checks the tools, the AWS sign-in and that you are an admin of a public repository.
2. Asks for the panel domain and the alert address, and optionally a CurseForge API key for modpacks.
3. Creates the Terraform state bucket (`spawnpoint-tfstate-<account>`) and writes every root's ignored `backend.hcl`.
4. Generates the session signing secret and the host passwords into SSM Parameter Store. Values never appear on a
   command line or in the output, and an existing parameter is never overwritten.
5. Applies three roots from your machine: `terraform-github` (the deploy, plan and release identities),
   `terraform-identity-admin` (the identity that changes them) and `terraform-domain` (the Route 53 zone). It shows each
   plan and asks before applying. A plan that deletes anything stops the script.
6. Turns Actions on in the fork, creates the `production`, `production-plan` and `production-identity` environments
   (you approve the last two), and sets the role ARNs, the alert address and the repository variables.
7. Prints the name servers to add as NS records for your subdomain at its parent's DNS provider.

Every step checks what exists first, so running the script again finishes a run that stopped part-way and changes
nothing else.

## After the script

- Add the NS records it printed. The panel certificate is issued only once they resolve.
- Confirm the email AWS sends to the alert address.
- Run the **Deploy production** workflow on `main`. Its first run deploys every unit. Cost anomaly detection follows on
  a later deploy, once Cost Explorer is ready in the new account.
- A new account starts in the SES sandbox. Email is optional; to send it, set a sender and ask AWS for production access
  ([ADR-0020](adr/0020-email-channel.md)).

## Not yet automated

- Claiming the first Owner without Telegram. Until the one-time owner link lands, set `TF_VAR_BOOTSTRAP_OWNER_TELEGRAM_ID`
  as a secret in the `production` and `production-plan` environments.
- Starting the first deploy from the script.
- A quick start without a domain.
- Branch protection for `main`.
