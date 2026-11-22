# Immutable release pipeline

This Terraform root owns the inert AWS builder for immutable mod releases: a content-addressed S3 source bundle, one
small on-demand CodeBuild project, its bounded log group and roles, and the `spawnpoint-build-release` Standard
Workflow. A build publishes a candidate but never changes `desired_release`, starts EC2 or touches a world.

It deliberately does not live in `../terraform`. Release construction has no dependency on the disposable game host,
and applying this root must not replace EC2, detach EBS, deploy the bot or change session workflows. Its only external
dependencies are the persistent release bucket from `../terraform-storage` and the CurseForge SecureString parameter.

## Order

`bootstrap` → `guardrails` → `storage` → **`releases`** → `github`.

The host can be managed independently. Promotion consumes candidates later, but construction does not depend on it.

## Secret prerequisite

Create the SecureString once without putting its value in shell history:

```bash
read -rsp 'CurseForge API key: ' CF_KEY && printf '\n'
printf '%s' "$CF_KEY" | aws ssm put-parameter \
  --name /spawnpoint/releases/curseforge-api-key \
  --type SecureString \
  --value file:///dev/stdin \
  --profile spawnpoint \
  --region eu-central-1
unset CF_KEY
```

CodeBuild receives the value directly from Parameter Store. GitHub and Terraform never receive it.

## Upstream cache

The builder keeps the upstream files it verified under `upstream/` in the release bucket
(`server/scripts/_upstream-cache.sh`): the server pack, the client archive and each client dependency by CurseForge
project and file id, with an index of `fileName`, `fileLength`, `sha1`, `sha256` and `classId`; the pack's client
mirror by its pinned SHA-512; Modrinth addons by version id and SHA-512. A file enters the cache only after the
CurseForge SHA-1 and size check, or the pinned SHA-512 and size check, passes. A hit is checked again against the
index or the pinned SHA-512; a miss, a mismatch or any S3 error falls back to the upstream download. An index hit for
a client dependency also skips its two metadata calls. Mods the `curseforge-files` resolver (`mc-image-helper`)
fetches are not cached.

The role may get and put objects under `upstream/` only. It has no `s3:ListBucket`, so S3 answers a missing key with
403; the builder treats that as a miss. It has no delete right: the storage root's lifecycle rule expires the prefix.

## Content-addressed layout

`release_storage_layout` selects what the builder writes: `legacy` (the default; per-release keys, as before) or
`objects-v1` (ADR-0080: objects named by SHA-256 under `objects/`, with a manifest that refers to them by digest). The
CodeBuild project gets it as `RELEASE_STORAGE_LAYOUT`. Keep `legacy` until the readers are deployed and the reconciler
report is clean. The project also gets `RELEASE_REFS_TABLE` (`release_refs_table_name`, created by `../terraform-storage`).

The layout is written by one bundled Node program, `lambdas/dist/release-writer/index.cjs`, which the source bundle
carries as `tools/release-writer.cjs`. Run `npm --prefix ../../lambdas run build` before `terraform plan`: the file must
exist then. The role may get, put, update and delete items on the reference table, and nothing else in DynamoDB; it
still has no `s3:Delete*`. The catalog builders hold each release a catalog lists before they write the catalog.

## Plan and apply

Copy `backend.hcl.example` to ignored `backend.hcl`, replace the account ID, then:

```bash
terraform init -backend-config=backend.hcl
terraform plan -out=releases.tfplan
terraform show releases.tfplan
terraform apply releases.tfplan
```

An apply creates only control-plane resources. CodeBuild charges only while a build actually runs; creating the project
does not start it.

## Local verification

```bash
terraform fmt -check -diff
terraform init -backend=false
terraform validate
terraform test
```

Mock tests create no AWS resources. They assert the fixed CodeBuild project, Parameter Store injection,
content-addressed source, single-flight small compute, and the Standard Workflow's caller-controlled field boundary.
