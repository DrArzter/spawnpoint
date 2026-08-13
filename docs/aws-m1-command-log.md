# AWS M1 command log

Executed on 2026-08-13 with AWS CLI profile `spawnpoint` in `eu-central-1`. This is both an execution log and a
learning aid: it records what changed, how it was checked, and why the command exists. Secrets and the transient public
IPv4 address are intentionally absent.

## Resulting resources

| Resource | Value | Purpose |
| --- | --- | --- |
| EC2 | `i-09c9b5069308ac372`, `m7i-flex.large`, `eu-central-1a` | Disposable x86 game host |
| Data EBS | `vol-01bcd86ae27b55682`, encrypted 20 GiB gp3 | Persistent world, release working set and ZeroTier identity |
| VPC | `vpc-09546cf6a50a13871` | Isolated M1 network |
| Security group | `sg-0a6611501d75b2acd` | No ingress; outbound connections only |
| Release | `releases/1.0/manifest.json`, 111 JARs | Immutable server-side mod set |
| Restored backup | `worlds/world/archives/world-20260812T201024Z-e3909da890fa9a79364617bd4feb1f4c095cc519c1778918cfa6a85403252e87.tar.zst` | Verified off-volume recovery source |
| ZeroTier node | `b9bc15e2cf` in network `b6079f73c6698651` | Stable private game and Grafana path; awaiting manual authorisation at the time of writing |

The manual M0 instance and volume remain stopped and untouched until the restored M1 server passes the in-game check.

## Terraform apply and drift check

The production root was initialised against the already bootstrapped remote backend. A saved plan was inspected before
apply; it contained **13 additions, 0 changes and 0 destroys**. Because persistent S3 lives in another Terraform root,
the compute plan could not delete the backup or release bucket.

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -v "$HOME/.aws:/tmp/terraform-home/.aws:ro" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 plan -out=tfplan

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -v "$HOME/.aws:/tmp/terraform-home/.aws:ro" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 apply tfplan

# Read: a fresh plan must say "No changes".
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -v "$HOME/.aws:/tmp/terraform-home/.aws:ro" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 plan -detailed-exitcode
```

The applied instance has termination protection enabled, no key pair and IMDSv2 required. The security-group API
returned an empty ingress list. SSM registered the host as Online without SSH.

## Inspecting commands sent through SSM

Every remote mutation used `AWS-RunShellScript`, began with `set -euo pipefail`, and was then inspected. The first line
matters: without it, a later successful diagnostic can hide an earlier failed command.

```bash
# Write: ask the managed instance to execute a bounded command list.
aws ssm send-command \
  --instance-ids i-09c9b5069308ac372 \
  --document-name AWS-RunShellScript \
  --parameters '{"commands":["set -euo pipefail","<commands>"]}' \
  --profile spawnpoint --region eu-central-1

# Read: wait for this exact invocation, then inspect status, exit code and output.
aws ssm wait command-executed \
  --command-id <command-id> \
  --instance-id i-09c9b5069308ac372 \
  --profile spawnpoint --region eu-central-1

aws ssm get-command-invocation \
  --command-id <command-id> \
  --instance-id i-09c9b5069308ac372 \
  --profile spawnpoint --region eu-central-1
```

Cloud-init completed in **52.48 seconds**. Docker, SSM and Docker Compose v5.1.4 were active. Diagnostic command:
`29fe9724-e33f-45c7-b7bc-b571153e19b4`.

## Preparing the new data volume

`/dev/sdf` is only the EC2 API attachment name. On Nitro, the actual device was `/dev/nvme1n1`; its serial was matched
to the exact EBS ID before doing anything destructive. `prepare-data-volume.sh` then refused unsafe candidates and was
explicitly allowed to format only that empty device.

```bash
# Read: maps NVMe devices back to EBS volume IDs.
sudo ebsnvme-id /dev/nvme1n1

# Write: formats only a proven-empty non-root device, mounts it and persists the UUID in fstab.
sudo server/scripts/prepare-data-volume.sh /dev/nvme1n1 --format-empty

# Read: checks the mount and available space.
findmnt /srv/spawnpoint
df -h /srv/spawnpoint
```

Result: XFS UUID `44a7f10a-7e8c-4820-b477-d8c37a4cc55c`, label `spawnpoint`, mounted at
`/srv/spawnpoint`. SSM command: `e353eb4b-3835-4b7e-904f-4a3cd06498f8`.

## Restoring the world with the EC2 role

Only checksum-verified repository scripts were delivered. The host did not receive the administrator's AWS keys: the
AWS CLI inside EC2 used the scoped instance role to read the one backup bucket.

```bash
AWS_REGION=eu-central-1 \
BACKUP_BUCKET=spawnpoint-backups-614934752397 \
  server/scripts/download-world-backup.sh <object-key> /tmp/world.tar.zst

server/scripts/verify-archive.sh /tmp/world.tar.zst
server/scripts/restore-world.sh /tmp/world.tar.zst /srv/spawnpoint/restore-staging
```

The downloaded archive was **417,306,157 bytes**, matched SHA-256
`e3909da890fa9a79364617bd4feb1f4c095cc519c1778918cfa6a85403252e87`, and restored **635,666,233 bytes**.
SSM command: `69773e12-34e7-440a-b789-9509ddd14124`.

## Publishing and reconciling release 1.0

Release publication was two-phase. All 111 JARs were uploaded first and their exact remote names and byte lengths were
compared with `server/releases/1.0/manifest.json`. Only after that diff was empty was the manifest uploaded as the
commit marker. The manifest's S3 VersionId is `.LMUZdCEJfiHPzEtHaT_h1E1Dtu02j.A`.

```bash
# Write: copy immutable objects below a versioned prefix.
aws s3 cp <local-mod-directory> \
  s3://spawnpoint-releases-614934752397/releases/1.0/mods/ \
  --recursive --profile spawnpoint --region eu-central-1

# Write, last: publish the commit marker only after inventory verification.
aws s3 cp server/releases/1.0/manifest.json \
  s3://spawnpoint-releases-614934752397/releases/1.0/manifest.json \
  --profile spawnpoint --region eu-central-1
```

The instance role downloaded the manifest and objects, and `reconcile-release.sh` confirmed **111 mods / 623,534,143
bytes** before the restored world was moved into `/srv/spawnpoint/app/server/data/world`. SSM command:
`a8ae196d-4450-4950-92e4-7c9f5c1e55d6`.

Release schema v1 formally hashes JARs only. A temporary, checksum-addressed runtime supplement carries the required
non-secret `config`, `defaultconfigs`, `tacz`, `tlm_custom_pack` and `patchouli_books` content. Files containing
password-like settings were excluded, as were `.env`, logs, caches, user lists and credentials. Artifact SHA-256:
`caa50f58cec01717cab0e74d5fcc8fac024897a65a4dbd04477c7c87785135cf`; SSM command:
`01263cb3-8974-4a2b-999b-c5072b08053b`. A later release-schema revision must make this supplement first-class.

## Runtime code and private bindings

Server code is archived from an exact Git commit and uploaded under a new key, never overwritten. Current bundle:

```text
S3 key: releases/1.0/server/spawnpoint-server-117c1cf.tar.zst
SHA-256: f813aff9cc3256feeab1a59f10d48abd5fac58f86f049e5e2863200dd4d085b0
Git commit: 117c1cf
```

The host verified the digest and archive paths before extraction. Its Compose render test proves Prometheus binds only
to `127.0.0.1:9090`, while Grafana may bind to `0.0.0.0:3000` inside the zero-ingress EC2 security group and private
ZeroTier overlay. The `.env` is mode `0600`; RCON received a random password that was never printed. Deployment SSM
command: `2f5af3e6-bca9-4828-b3d9-c7cbd450ac67`.

All six pinned session images were then pulled without creating containers. This separates registry transfer from the
Minecraft cold-start measurement and leaves the restored world untouched. The images occupy **2.428 GB** on the
disposable root disk; it remains **42% free**. The persistent EBS remains **90% free**. SSM command:
`25a1895a-c727-48b2-b391-b29958b8dac8`.

## ZeroTier gate

The identity lives below `/srv/spawnpoint`, so replacing the disposable root volume does not create a new overlay
identity. Read its status with:

```bash
zerotier-cli info
zerotier-cli listnetworks
```

At the last check, the daemon was `ONLINE`, but network membership was `ACCESS_DENIED`. Minecraft is deliberately not
started until node `b9bc15e2cf` is authorised in ZeroTier Central and receives a managed address. That is a security
gate, not a server-health failure.
