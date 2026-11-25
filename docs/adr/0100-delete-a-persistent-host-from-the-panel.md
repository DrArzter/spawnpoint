# ADR-0100 — Delete a persistent host from the panel

- Status: Accepted
- Date: 2026-11-25
- Milestone: M6
- Relates: [ADR-0043](0043-deploy-production-from-reviewed-pull-requests.md), [ADR-0054](0054-place-a-session-on-a-host-with-room.md),
  [ADR-0085](0085-a-persistent-host-serves-public-worlds-too.md), [ADR-0097](0097-every-world-is-a-record-in-the-registry.md)

## Context

A world can now move from the persistent host to the fleet in its settings (ADR-0097), and every world in
production has. The persistent host then serves nothing, yet its two disks still cost money. The owners want to delete
such a host from the panel, and keep the ability to have a persistent host at all.

The host was owned by Terraform (`infra/terraform`). A panel that terminated it would see it made again by the next
deploy, and three other roots (bot, operations, access API) looked it up by tag as a required data source, so their
plans would fail once it was gone.

## Decision

- **The panel owns the persistent host.** Terraform lets the instance, its data volume, the attachment and its
  running-hours alarm go with `removed { lifecycle { destroy = false } }`. Nothing in AWS changes on that deploy.
- **The host is found by its Name tag, never by its id.** Every grant that reached the instance by ARN admits
  `instance/*` with the condition `Name = spawnpoint-game-host` instead. The operations root lists the host with
  `aws_instances`, which may be empty; its two EC2 event rules then match an id no instance has, so they stay in place
  and no later deploy deletes them. The bot reads its world's session record (ADR-0062) for `/status` instead of the
  host's EC2 state.
- **Deleting is an operation.** `DELETE /hosts/{instanceId}` (permission `host.manage`, Owner by default) refuses a
  launched host, a host that is not stopped, a host while any active world has placement `configured`, and any request
  while an operation runs. It reads the host's data volumes and starts `spawnpoint-delete-host`: snapshot each data
  volume and wait until it completes when asked, lift termination protection, terminate, wait, delete the data
  volumes, delete the CPU alarms on the instance. Its grants reach only an instance named `spawnpoint-game-host`, volumes
  named `spawnpoint-data` and alarms named `spawnpoint-*`.
- **The snapshot is asked each time.** The confirmation dialog shows a checkbox, on by default, and asks for the
  host's name typed in. A kept snapshot is tagged `spawnpoint-deleted-host-data` with the host and operation ids, and is
  deleted by hand when no longer wanted.
- **The worlds page offers it.** When the persistent host exists and no live world is placed on it, a notice says so
  with a "Delete host" action, disabled with a reason while the host runs.

## Consequences

- The first deploy after this change only forgets four resources in Terraform state; `terraform-apply-safe.sh` counts
  deletes, not forgets, so no allow-list entry is needed.
- After a deletion, `infra/terraform` no longer creates a persistent host. Adding one again is a later decision:
  either a "Add host" operation in the panel, or the resources back in Terraform with an `import`.
- The security group `spawnpoint-game-host` and the instance profile stay: the fleet's launch template uses the profile,
  and an unused security group costs nothing.
- `server/user-data.sh` and `server/worlds/catalog.json` stay for a persistent host the deployment may have again.
- An encrypted volume's snapshot uses the account's default EBS key, as the volume does.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A deploy switch: a repository variable makes the host optional in Terraform | Deleting would need a variable change and a gated deploy instead of a button; the owners chose the panel |
| Delete through Terraform with an allow-listed destroy | The same, once; and the rules that name the host would still break the other roots' plans |
| Always snapshot, or never | The owners chose to be asked each time |
| Show the host on its own page | No host page exists in a fleet deployment; a notice on the worlds page appears exactly when the action makes sense |
