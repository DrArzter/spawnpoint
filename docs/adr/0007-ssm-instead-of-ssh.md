# ADR-0007 — Manage the instance with SSM, not SSH

- Status: Accepted
- Date: 2026-08-11
- Milestone: M1

## Context

The automation needs to run commands on the instance: sync mods, restart the container, trigger a world
save, read logs. A human occasionally needs a shell for diagnosis.

The default answer is SSH with a key pair. On an instance that sits directly on the internet, that means
an open inbound port, a private key on a laptop, and no record of what was run. It also means the Lambda
functions need network reach into the VPC and a copy of the key, which is both awkward and unsafe.

AWS Systems Manager gives the same capability through the AWS API: Run Command for automation, Session
Manager for interactive shells. The agent connects outbound, access is controlled by IAM, and every
invocation is recorded in CloudTrail.

## Decision

Use SSM Run Command for all automation and SSM Session Manager for interactive access. Do not open an
inbound SSH port, and do not attach an SSH key pair to the instance.

The instance gets an instance profile with the managed SSM policy plus narrowly scoped access to the two
S3 buckets it needs. Each Lambda gets permission to send specific SSM documents to instances carrying
the project tag, and nothing wider.

## Consequences

**Good**

- In the chosen ZeroTier mode the security group has no inbound rules. No game or SSH surface is public.
- No private key to distribute, rotate or lose.
- Every command is attributable in CloudTrail. That audit trail is what a production system requires,
  and here it costs nothing extra.
- Lambda reaches the instance through the AWS API, so no VPC attachment and no key material in the
  function.

**Bad, or risky**

- The SSM agent must be healthy and able to reach the SSM endpoints. If the agent breaks, access is lost.
- Interactive sessions are slower and less comfortable than plain SSH.
- Diagnosing "the instance does not appear as a managed node" is a learning curve of its own.

**Mitigations**

- Use an AMI with the agent preinstalled — Amazon Linux, or Ubuntu with the agent enabled.
- The instance sits in a public subnet behind an internet gateway, so no VPC endpoints are required. If it
  ever moves to a private subnet, interface endpoints become a requirement and a cost.
- Break-glass path in the runbook: the world lives on a separate volume, so replacing the instance is the
  recovery route, rather than fighting for a shell.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| SSH with a key pair | Open inbound port on an internet-facing host, key distribution, no audit trail |
| SSH restricted to one home IP | Better, but the IP changes, and automation still needs a key |
| EC2 Instance Connect | Still SSH on the wire, and the port must still be reachable |
| RCON only, no shell | RCON covers in-game commands, but cannot sync files or restart the container |
| User data on every boot | Correct for boot-time setup, and used for that, but cannot act on a server that is already running |
