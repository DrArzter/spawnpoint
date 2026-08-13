# AWS M0 command log

Commands used to build the manual M0 environment, with the effect, verification and rollback written beside each
change. This is an execution log and learning aid, not the eventual infrastructure definition. M1 replaces these
manual resources with Terraform.

The account ID and generated AWS resource IDs are intentionally not committed. Commands discover them from AWS by
name, tag or the current login. The AWS CLI profile uses temporary browser credentials as described in
[AWS CLI checks](aws-cli-checks.md).

## Conventions

```bash
SP_PROFILE=spawnpoint
SP_REGION=eu-central-1
```

- **Read** commands are safe observations and do not change AWS.
- **Write** commands create or modify the resource named in the command.
- **Rollback** commands remove only that explicitly named resource.
- Every billable write gets a separate cost warning; the current inventory records what continues to exist.

## Current manual inventory

Last reconciled against AWS on 2026-08-13. Generated IDs stay out of the public repository; the read commands below
resolve them by unique names and project tags.

| Resource | Name | Location | Current state | Cost shape |
| --- | --- | --- | --- | --- |
| IAM role and instance profile | `spawnpoint-m0-ec2` | Global | Created; SSM core policy only | No standalone charge |
| Security group | `spawnpoint-m0-minecraft` | `eu-central-1`, default VPC | Created; no inbound rules | No standalone charge |
| EBS data volume | `spawnpoint-m0-data` | `eu-central-1a` / `euc1-az2` | Encrypted gp3, 20 GB; attached with `DeleteOnTermination=false`; XFS label `spawnpoint` | About $1.90/month list-price equivalent before credits |
| EC2 smoke host | `spawnpoint-m0-smoke` | `eu-central-1a` / `euc1-az2` | `m7i-flex.large`, stopped; termination-protected; no key pair; 8 GB encrypted gp3 root | No compute while stopped; root is about $0.76/month list-price equivalent before credits |

Resolve the current generated IDs and verify that names remain unique:

```bash
aws ec2 describe-volumes \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=tag:Name,Values=spawnpoint-m0-data Name=tag:Project,Values=spawnpoint \
  --query 'Volumes[].[VolumeId,State,Size,VolumeType,Encrypted,AvailabilityZone,Attachments]'

aws ec2 describe-instances \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=tag:Project,Values=spawnpoint Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,Placement.AvailabilityZone]'
```

Historical rollback for a still-empty and unattached data volume. It is intentionally not applicable to the current
attached state:

```bash
SP_DATA_VOLUME_ID="$(aws ec2 describe-volumes \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=tag:Name,Values=spawnpoint-m0-data Name=status,Values=available \
  --query 'Volumes[0].VolumeId' \
  --output text)"

aws ec2 delete-volume \
  --volume-id "$SP_DATA_VOLUME_ID" \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE"
```

Do not use that rollback while the volume is attached, or after it contains a world. At that point the runbook must
stop the instance, detach it, and snapshot or archive it first.

## Region and Availability Zone inventory

**Read:** list available AZ names and their stable physical Zone IDs:

```bash
aws ec2 describe-availability-zones \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=state,Values=available \
  --query 'AvailabilityZones[].[ZoneName,ZoneId,OptInStatus]' \
  --output table
```

AZ letters are account-specific aliases; the Zone ID identifies the physical zone. This account exposes:

| AZ name | Zone ID |
| --- | --- |
| `eu-central-1a` | `euc1-az2` |
| `eu-central-1b` | `euc1-az3` |
| `eu-central-1c` | `euc1-az1` |

**Read:** confirm that the chosen `r8i.large` is offered in each AZ:

```bash
aws ec2 describe-instance-type-offerings \
  --location-type availability-zone \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=instance-type,Values=r8i.large \
  --query 'InstanceTypeOfferings[].Location' \
  --output table
```

**Read:** check the On-Demand Standard instance quota. The quota is in vCPUs; `r8i.large` needs two:

```bash
aws service-quotas get-service-quota \
  --service-code ec2 \
  --quota-code L-1216C47A \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query 'Quota.{Name:QuotaName,Value:Value,Adjustable:Adjustable}' \
  --output table
```

Result on 2026-08-13: quota `5`, so one `r8i.large` fits. M0 uses `eu-central-1a` / `euc1-az2`; all three offerings
were otherwise equivalent.

## AMI and price gate

**Read:** resolve AWS's current x86_64 Amazon Linux 2023 image rather than committing an AMI ID that silently ages:

```bash
SP_AMI_ID="$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query Parameter.Value \
  --output text)"

aws ec2 describe-images \
  --image-ids "$SP_AMI_ID" \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query 'Images[0].{ImageId:ImageId,Name:Name,Architecture:Architecture,RootDevice:RootDeviceName,RootGiB:BlockDeviceMappings[0].Ebs.VolumeSize}' \
  --output table
```

Result on 2026-08-13: `ami-070cc8ab883065d64`, AL2023 release `2023.12.20260803.3`, x86_64, with an 8 GB root
volume. The launch command will resolve the parameter again immediately before use.

**Read:** query the global Price List endpoint for the two Frankfurt rates that AWS exposes there:

```bash
aws pricing get-products \
  --service-code AmazonEC2 \
  --region us-east-1 \
  --profile "$SP_PROFILE" \
  --filters \
    Type=TERM_MATCH,Field=location,Value='EU (Frankfurt)' \
    Type=TERM_MATCH,Field=instanceType,Value=r8i.large \
    Type=TERM_MATCH,Field=operatingSystem,Value=Linux \
    Type=TERM_MATCH,Field=tenancy,Value=Shared \
    Type=TERM_MATCH,Field=preInstalledSw,Value=NA \
    Type=TERM_MATCH,Field=capacitystatus,Value=Used

aws pricing get-products \
  --service-code AmazonEC2 \
  --region us-east-1 \
  --profile "$SP_PROFILE" \
  --filters \
    Type=TERM_MATCH,Field=location,Value='EU (Frankfurt)' \
    Type=TERM_MATCH,Field=volumeApiName,Value=gp3
```

Results on 2026-08-13:

- `r8i.large`: `$0.16758` per running hour;
- gp3 baseline storage: `$0.0952` per GB-month;
- public IPv4: `$0.005` per running hour from Amazon VPC pricing.

The first M0 run therefore creates two billable resources: one 20 GB gp3 data volume at about `$1.90/month` while
it exists, plus the instance whose 8 GB root volume costs about `$0.76/month` while it exists. Running compute plus
public IPv4 costs about `$0.17258/hour`. No launch command belongs in this log until that cost gate is accepted.

The cost gate was accepted on 2026-08-13.

**Write:** create the persistent data volume explicitly encrypted, in the selected AZ, with no attachment implied:

```bash
aws ec2 create-volume \
  --availability-zone eu-central-1a \
  --size 20 \
  --volume-type gp3 \
  --encrypted \
  --tag-specifications \
    'ResourceType=volume,Tags=[{Key=Name,Value=spawnpoint-m0-data},{Key=Project,Value=spawnpoint},{Key=Environment,Value=m0},{Key=ManagedBy,Value=manual},{Key=Purpose,Value=minecraft-data}]' \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE"
```

AWS returned one encrypted 20 GB gp3 volume in `eu-central-1a`; `volume-available` completed and a describe confirmed
that it had no attachments. Launching `r8i.large` was then rejected before an instance was created:

```text
InvalidParameterCombination: The specified instance type is not eligible for Free Tier.
```

This is an account-plan restriction, not a quota or capacity failure. A read immediately afterwards confirmed zero
Spawnpoint instances and the one unattached data volume above.

**Read:** inspect the Free Plan without upgrading it:

```bash
aws freetier get-account-plan-state \
  --region us-east-1 \
  --profile "$SP_PROFILE"

aws ec2 describe-instance-types \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=free-tier-eligible,Values=true \
  --query 'InstanceTypes[].[InstanceType,VCpuInfo.DefaultVCpus,MemoryInfo.SizeInMiB,FreeTierEligible]' \
  --output table
```

Result: plan `FREE`, status `ACTIVE`, `$120` credits remaining, expiry `2027-02-11`. The available x86 smoke-test
shape closest to the intended host is `m7i-flex.large` with 2 vCPU and 8 GiB. It can validate user-data, SSM, EBS,
ZeroTier and Docker under the Free Plan, but it does not supersede the 16 GiB production sizing decision.

## Existing network inventory

**Read:** inspect VPCs and public-IP behavior of their subnets:

```bash
aws ec2 describe-vpcs \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query 'Vpcs[].[VpcId,CidrBlock,IsDefault,State]' \
  --output table

aws ec2 describe-subnets \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query 'Subnets[].[SubnetId,AvailabilityZone,AvailabilityZoneId,VpcId,CidrBlock,MapPublicIpOnLaunch]' \
  --output table
```

The fresh account has one default VPC and one subnet per AZ, with public-IP mapping enabled. M0 reuses that network;
M1 builds and owns the real VPC in Terraform.

Resolve the default VPC and selected subnet when a later command needs their IDs:

```bash
SP_VPC_ID="$(aws ec2 describe-vpcs \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)"

SP_SUBNET_ID="$(aws ec2 describe-subnets \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=vpc-id,Values="$SP_VPC_ID" Name=availability-zone,Values=eu-central-1a \
  --query 'Subnets[0].SubnetId' \
  --output text)"
```

## EC2 identity for Systems Manager

The instance must use SSM with no SSH key and no inbound port 22. An EC2 instance receives permissions through an
instance profile containing an IAM role.

**Write:** create a role whose trust policy permits only the EC2 service to assume it:

```bash
aws iam create-role \
  --role-name spawnpoint-m0-ec2 \
  --description 'M0 Minecraft host managed through SSM' \
  --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --tags Key=Project,Value=spawnpoint Key=Environment,Value=m0 Key=ManagedBy,Value=manual \
  --profile "$SP_PROFILE"
```

**Write:** attach AWS's managed SSM core policy. This permits the agent to register and exchange SSM messages; it does
not grant general administrator access to the instance:

```bash
aws iam attach-role-policy \
  --role-name spawnpoint-m0-ec2 \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore \
  --profile "$SP_PROFILE"
```

**Write:** create the EC2-facing instance profile and put the role inside it:

```bash
aws iam create-instance-profile \
  --instance-profile-name spawnpoint-m0-ec2 \
  --tags Key=Project,Value=spawnpoint Key=Environment,Value=m0 Key=ManagedBy,Value=manual \
  --profile "$SP_PROFILE"

aws iam add-role-to-instance-profile \
  --instance-profile-name spawnpoint-m0-ec2 \
  --role-name spawnpoint-m0-ec2 \
  --profile "$SP_PROFILE"
```

**Read:** verify the exact attached policy and that the role is inside the profile:

```bash
aws iam list-attached-role-policies \
  --role-name spawnpoint-m0-ec2 \
  --profile "$SP_PROFILE"

aws iam get-instance-profile \
  --instance-profile-name spawnpoint-m0-ec2 \
  --profile "$SP_PROFILE"
```

**Rollback:** dependency order matters:

```bash
aws iam remove-role-from-instance-profile \
  --instance-profile-name spawnpoint-m0-ec2 \
  --role-name spawnpoint-m0-ec2 \
  --profile "$SP_PROFILE"

aws iam delete-instance-profile \
  --instance-profile-name spawnpoint-m0-ec2 \
  --profile "$SP_PROFILE"

aws iam detach-role-policy \
  --role-name spawnpoint-m0-ec2 \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore \
  --profile "$SP_PROFILE"

aws iam delete-role \
  --role-name spawnpoint-m0-ec2 \
  --profile "$SP_PROFILE"
```

## Security group

**Write:** create a named group in the default VPC. A new group has no inbound rules and one allow-all outbound rule.
The outbound rule lets the future host reach SSM, image registries and mod sources without a NAT Gateway.

```bash
SP_VPC_ID="$(aws ec2 describe-vpcs \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)"

aws ec2 create-security-group \
  --group-name spawnpoint-m0-minecraft \
  --description 'Spawnpoint M0 Minecraft ingress; no SSH' \
  --vpc-id "$SP_VPC_ID" \
  --tag-specifications \
    'ResourceType=security-group,Tags=[{Key=Name,Value=spawnpoint-m0-minecraft},{Key=Project,Value=spawnpoint},{Key=Environment,Value=m0},{Key=ManagedBy,Value=manual}]' \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE"
```

The terminal request was interrupted after AWS accepted it. A subsequent read confirmed that exactly one group was
created, with no inbound rules. An interrupted client is not evidence that the remote operation failed; always read
the resulting state before retrying a create command.

**Read:** verify that `IpPermissions` is empty and discover the generated group ID:

```bash
aws ec2 describe-security-groups \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=group-name,Values=spawnpoint-m0-minecraft Name=vpc-id,Values="$SP_VPC_ID"
```

Neither `25565/tcp` nor `22/tcp` will be added. M0 uses ZeroTier mode C, so the game security group stays without
inbound rules. ZeroTier initiates outbound traffic through the existing allow-all egress rule.

**Rollback:** resolve the generated ID and delete only this group:

```bash
SP_SECURITY_GROUP_ID="$(aws ec2 describe-security-groups \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=group-name,Values=spawnpoint-m0-minecraft Name=vpc-id,Values="$SP_VPC_ID" \
  --query 'SecurityGroups[0].GroupId' \
  --output text)"

aws ec2 delete-security-group \
  --group-id "$SP_SECURITY_GROUP_ID" \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE"
```

## Verify that no billable compute exists

These reads were run after IAM and security-group creation and returned empty arrays:

```bash
aws ec2 describe-instances \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query 'Reservations[].Instances[?State.Name!=`terminated`].[InstanceId,State.Name,InstanceType]'

aws ec2 describe-volumes \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query 'Volumes[].[VolumeId,State,Size,VolumeType]'

aws ec2 describe-nat-gateways \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query 'NatGateways[?State!=`deleted`].[NatGatewayId,State]'

aws ec2 describe-addresses \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query 'Addresses[].[AllocationId,PublicIp]'
```

IAM roles, instance profiles and security groups have no standalone hourly charge. They can authorize or protect
billable resources, which is why the empty-resource checks still matter.

## Host bootstrap artifacts

These local checks do not change AWS. They validate the exact files that will later be supplied to EC2 and invoked
through SSM:

```bash
bash -n server/user-data.sh \
  server/scripts/prepare-data-volume.sh \
  server/scripts/configure-zerotier.sh

docker run --rm \
  -v "$PWD:/mnt:ro" \
  koalaman/shellcheck@sha256:bb596a0d169b85ddd81d8b6d3a2ff6d5baf5fca10b97f575ebc647c3dff62b3d \
  /mnt/server/user-data.sh \
  /mnt/server/scripts/prepare-data-volume.sh \
  /mnt/server/scripts/configure-zerotier.sh

docker run --rm \
  amazonlinux@sha256:694092ae18877ed4e3cb9b643759ba95df1f12af12528fefa18f60f79d4c1568 \
  bash -c \
  'for package_name in docker git jq rsync tar zstd xfsprogs; do
     dnf repoquery --available --quiet "${package_name}" >/dev/null || exit 1
   done'
```

- `bash -n` parses each script without running it.
- The digest-pinned ShellCheck container catches unsafe quoting, surprising expansions and common shell mistakes
  without installing another host tool. This check completed with no findings on 2026-08-13.
- The Amazon Linux 2023 container asks that distribution's own repository whether every user-data package exists. It
  downloads no packages into the host and completed successfully on 2026-08-13.

`server/user-data.sh` is intentionally limited to the disposable root volume: it installs Docker and utility
packages, enables SSM, and creates empty mount points. It cannot safely identify the later EBS device or know which
Git commit and secrets to deploy.

The base bootstrap was verified without SSH by sending a strict shell through SSM, waiting for the invocation, and
reading both output streams and the response code:

```bash
SP_COMMAND_ID="$(aws ssm send-command \
  --instance-ids "$SP_INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment 'Spawnpoint M0 verify base bootstrap' \
  --parameters \
    'commands=["set -euo pipefail","cloud-init status --wait","systemctl is-active docker","systemctl is-active amazon-ssm-agent","rpm -q docker git jq rsync tar zstd xfsprogs","if findmnt /srv/spawnpoint; then exit 1; else echo data_mount=not_mounted; fi"]' \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query Command.CommandId \
  --output text)"

aws ssm wait command-executed \
  --command-id "$SP_COMMAND_ID" \
  --instance-id "$SP_INSTANCE_ID" \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE"

aws ssm get-command-invocation \
  --command-id "$SP_COMMAND_ID" \
  --instance-id "$SP_INSTANCE_ID" \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}'
```

These were the first-session commands. Device identification, formatting and mount verification have now executed;
ZeroTier remains pending its real Network ID:

```bash
# Read: map the attached EBS volume ID to its actual NVMe device name.
sudo /sbin/ebsnvme-id /dev/nvme1n1
lsblk --fs

# Write, destructive only for a genuinely empty device: create XFS and persist
# its UUID in /etc/fstab. Omit --format-empty when reattaching an existing world.
sudo server/scripts/prepare-data-volume.sh /dev/nvme1n1 --format-empty

# Read: verify the expected filesystem is mounted before putting state on it.
findmnt /srv/spawnpoint

# Write: install ZeroTier only after its state path is bound to EBS, then ask
# the chosen network controller to admit this node. A Network ID is not a token.
sudo server/scripts/configure-zerotier.sh <16-hex-network-id>
```

The device name above is an example, not a value to copy blindly. Nitro instances rename requested EBS device names
to NVMe names; `ebsnvme-id` is the evidence connecting that device to the exact volume created for Spawnpoint.

`prepare-data-volume.sh` refuses the root device, devices with child partitions, already-mounted devices and blank
devices unless `--format-empty` is explicit. `configure-zerotier.sh` refuses to run unless `/srv/spawnpoint` is a real
mount, so `identity.secret` cannot silently land on the disposable root disk.

Every `AWS-RunShellScript` command list starts with `set -euo pipefail`. Without it, Run Command concatenates the list
into one shell script and can report the final successful diagnostic as `Success` even when an earlier command failed.
This was observed during the first format attempt: XFS rejected the original 15-character label
`spawnpoint-data` (XFS permits at most 12), a later `lsblk` succeeded, and SSM returned success with the real error only
in stderr. The volume remained blank. The script now uses the label `spawnpoint`; both the wrapper exit discipline and
stderr must be checked before accepting an invocation.

The first ZeroTier install exposed a similar ordering detail: the official installer starts `zerotier-one` as part of
package installation, before `configure-zerotier.sh` creates the network's auto-join file. `systemctl enable --now`
does not restart an already active service, so the node had a persistent identity but had not requested network
membership. The script now enables and explicitly restarts the service after writing the file; this is also safe on
idempotent retries. The service can report `active` before its local CLI control socket accepts connections, so the
script also waits for that socket for up to 30 seconds instead of treating the startup race as a failed install.

## Executed smoke-host lifecycle

The accepted 16 GiB `r8i.large` cannot be launched while the account remains on the Free Plan. M0 therefore used the
closest eligible x86 shape, `m7i-flex.large` with 8 GiB, to validate the host mechanisms only. This does not change the
real-server sizing decision.

**Write:** launch exactly one smoke host with no SSH key, no inbound security-group rule, mandatory IMDSv2, API
termination protection and an 8 GB encrypted disposable root volume:

```bash
SP_AMI_ID="$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --query Parameter.Value \
  --output text)"

SP_SUBNET_ID="$(aws ec2 describe-subnets \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=availability-zone,Values=eu-central-1a Name=default-for-az,Values=true \
  --query 'Subnets[0].SubnetId' \
  --output text)"

SP_SECURITY_GROUP_ID="$(aws ec2 describe-security-groups \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=group-name,Values=spawnpoint-m0-minecraft \
  --query 'SecurityGroups[0].GroupId' \
  --output text)"

aws ec2 run-instances \
  --image-id "$SP_AMI_ID" \
  --instance-type m7i-flex.large \
  --count 1 \
  --network-interfaces \
    "DeviceIndex=0,SubnetId=${SP_SUBNET_ID},Groups=${SP_SECURITY_GROUP_ID},AssociatePublicIpAddress=true,DeleteOnTermination=true" \
  --iam-instance-profile Name=spawnpoint-m0-ec2 \
  --user-data file://server/user-data.sh \
  --block-device-mappings \
    'DeviceName=/dev/xvda,Ebs={VolumeSize=8,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
  --metadata-options \
    'HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1,InstanceMetadataTags=enabled' \
  --instance-initiated-shutdown-behavior stop \
  --disable-api-termination \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Name,Value=spawnpoint-m0-smoke},{Key=Project,Value=spawnpoint},{Key=Environment,Value=m0},{Key=ManagedBy,Value=manual},{Key=Purpose,Value=bootstrap-smoke}]' \
    'ResourceType=volume,Tags=[{Key=Name,Value=spawnpoint-m0-smoke-root},{Key=Project,Value=spawnpoint},{Key=Environment,Value=m0},{Key=ManagedBy,Value=manual},{Key=Purpose,Value=disposable-root}]' \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE"
```

The instance reached EC2 status `ok`, registered in SSM as Amazon Linux 2023 with Agent `3.3.4624.0`, and completed
cloud-init in 49 seconds. Docker and SSM were active, all expected packages were installed, and `/srv/spawnpoint` was
correctly still unmounted.

**Write:** resolve both resources by tag and attach the data volume. Requested `/dev/sdf` is only an API name; Nitro
presented it inside Linux as `/dev/nvme1n1`:

```bash
SP_INSTANCE_ID="$(aws ec2 describe-instances \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=tag:Name,Values=spawnpoint-m0-smoke Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)"

SP_DATA_VOLUME_ID="$(aws ec2 describe-volumes \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=tag:Name,Values=spawnpoint-m0-data Name=status,Values=available \
  --query 'Volumes[0].VolumeId' \
  --output text)"

aws ec2 attach-volume \
  --volume-id "$SP_DATA_VOLUME_ID" \
  --instance-id "$SP_INSTANCE_ID" \
  --device /dev/sdf \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE"
```

Before formatting, `ebsnvme-id /dev/nvme1n1` was checked against `SP_DATA_VOLUME_ID`, while `lsblk --fs` and `blkid`
confirmed no partitions and no filesystem. The corrected `prepare-data-volume.sh /dev/nvme1n1 --format-empty` then
created XFS and mounted it at `/srv/spawnpoint`. A reboot produced a new boot ID, automatically restored the same
filesystem UUID through `/etc/fstab`, and returned both Docker and SSM to `active`.

**Write:** stop the smoke host immediately after validation so compute and public IPv4 stop consuming credits:

```bash
SP_INSTANCE_ID="$(aws ec2 describe-instances \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE" \
  --filters Name=tag:Name,Values=spawnpoint-m0-smoke Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)"

aws ec2 stop-instances \
  --instance-ids "$SP_INSTANCE_ID" \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE"

aws ec2 wait instance-stopped \
  --instance-ids "$SP_INSTANCE_ID" \
  --region "$SP_REGION" \
  --profile "$SP_PROFILE"
```

Final state on 2026-08-13: smoke host `stopped`, no public IPv4, root volume attached with
`DeleteOnTermination=true`, data volume attached with `DeleteOnTermination=false`. Stopped instances do not consume
compute hours; both EBS volumes continue to exist.

## Executed ZeroTier first join

The selected Network ID is `b6079f73c6698651`. A Network ID identifies the virtual network; it is not the Central API
token and does not authorize a node by itself.

The smoke host was started, its data-volume UUID checked, and `configure-zerotier.sh` delivered through SSM. The
official installer installed ZeroTier `1.16.2`. Before installation, `/var/lib/zerotier-one` was bind-mounted from
`/srv/spawnpoint/system/zerotier-one`, so the generated `identity.secret`, local API tokens and network membership all
landed on EBS rather than the disposable root volume.

The first join reached:

```text
ZeroTier service: ONLINE
Network: b6079f73c6698651
Membership: ACCESS_DENIED
```

`ACCESS_DENIED` is the expected pre-authorization state for a private network. The generated node ID is intentionally
not committed; it is visible in ZeroTier Central and through `zerotier-cli info`. The host was stopped while waiting
for manual authorization, so it does not consume compute credits.

## DNS and Route 53

Deferred. M0 uses ZeroTier and owns no domain or Route 53 hosted zone. If DNS is chosen later, its exact create,
verification and rollback commands get a new section rather than being mixed into the executed M0 log.
