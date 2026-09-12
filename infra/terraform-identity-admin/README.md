# The identity anchor

This root owns one IAM role, `spawnpoint-github-identity-admin`, and nothing else. It exists so that
[`../terraform-github`](../terraform-github/) — the root that defines the pipeline's deploy and plan identities — can be
applied by the pipeline without the pipeline being able to widen its own permissions.

The deployment identity is denied from editing itself and from touching this role; this role may change the GitHub
identities and the OIDC provider — create and update, never delete — and is denied from touching itself. Its trust is
pinned to one OIDC subject: this repository's owner-reviewed `production-identity` environment, so a run of the
`identity` job in `Deploy production` receives it only after the owner approves the gate, and only for a commit that
`Check` has already passed on `main`.

**This root is applied by hand, and is never applied by any pipeline identity.** That is the whole point: something has
to be the anchor, and the anchor has to sit outside the automation's reach. It changes only when the repository
identity or the environment name changes, which should be never. A change to it is reported as manual work by the
production workflow, which then verifies a zero-change read-only plan before it considers the step complete.

## Order

`bootstrap` → `guardrails` → `storage` → `releases` → **`identity-admin`** → `github`.

## Plan and apply

Copy `backend.hcl.example` to ignored `backend.hcl`, replace the account ID, then:

```bash
terraform init -backend-config=backend.hcl
terraform plan -out=identity-admin.tfplan
terraform show identity-admin.tfplan
terraform apply identity-admin.tfplan
```

The first apply creates exactly two resources: the role and its inline policy. Then, once:

```bash
gh api --method PUT repos/DrArzter/spawnpoint/environments/production-identity \
  --input - <<'JSON'
{"reviewers":[{"type":"User","id":102290466}],"prevent_self_review":false}
JSON
gh variable set AWS_IDENTITY_ROLE_ARN \
  --repo DrArzter/spawnpoint \
  --env production-identity \
  --body "$(terraform output -raw github_identity_admin_role_arn)"
```

## Local verification

```bash
terraform fmt -check -diff
terraform init -backend=false
terraform validate
terraform test
```

The mock tests use no AWS credentials and create no resources. They pin the trust subject, refuse any `iam:Delete*`
grant, scope every IAM permission to the `spawnpoint-github-*` roles or the provider, and assert the self-deny.
