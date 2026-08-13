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
- Every billable write gets a separate cost warning. Nothing in this document so far is billable by itself.

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

The following commands are **prepared, not yet executed**. They belong to the first SSM session after the instance
and EBS volume exist:

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

## DNS and Route 53

Deferred. M0 uses ZeroTier and owns no domain or Route 53 hosted zone. If DNS is chosen later, its exact create,
verification and rollback commands get a new section rather than being mixed into the executed M0 log.
