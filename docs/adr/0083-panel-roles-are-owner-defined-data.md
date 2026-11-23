# ADR-0083 — Panel roles are owner-defined data

- Status: Accepted
- Date: 2026-11-23
- Milestone: M6
- Supersedes: the fixed-roles part of [ADR-0036](0036-observed-visitors-and-owner-approved-access.md) (four built-in
  roles fixed in code)
- Amends: [ADR-0050](0050-default-role-on-sign-in-and-elevation-requests.md) (the default role is stored data, not
  the literal `viewer`), [ADR-0070](0070-give-each-group-a-space-in-an-aws-account-it-brings.md) (roles stay
  deployment-wide)

## Context

A panel role is a named set of permissions, and every identity holds one. Until now the four roles (viewer, player,
operator, owner) were fixed in code, and the API refused any other role id. The owner could not change what a role
grants, add a role, or choose the role a new person gets. The owner has asked for roles that are as customisable as
possible, with the built-in roles only as safe defaults.

Wave 1 of the technical-debt review prepared one seam for this: one permission resolver, one owner guard keyed on
the role's `protected` flag, and a role list served with the permission catalogue.

## Decision

1. **Permissions stay code.** They are the route gates. The API serves them as a catalogue (id, group, label,
   description, `reserved`). `access.owner.grant` is reserved.
2. **Roles are records.** `ROLE#<id>` / `DEFINITION` holds `name`, `description`, `permissions`, `version`,
   `updated_at` and `updated_by`. A role id is a lower-case slug of up to 32 characters.
   - The four built-in roles keep their ids, so stored profiles need no migration. A built-in role with no record
     uses its definition in code (version 1). The first edit writes its record.
   - A built-in role can be edited but not deleted.
3. **One protected role, Owner.** It holds every permission, and it cannot be edited or deleted: its definition is
   always the one in code. Only this role holds a reserved permission. No custom role and no direct grant may hold one.
4. **Last-owner rule.** At least one active identity holds the protected role. It is checked through the role's flag.
5. **No escalation.** A caller may give a role, take one away, or put a permission into a role only when the caller
   holds every permission involved. This replaces the "touches Owner" checks. A direct grant still needs
   `access.owner.grant`.
6. **One resolver, one read per request.** The identity's role record is read with a consistent read when the identity
   is resolved, with no cache across requests. An unknown role grants nothing, and its direct grants still apply.
7. **One read for the web.** `GET /access/roles` returns `{ roles, permissions, defaultRoleId }`. Each role carries
   `builtIn`, `protected`, `version`, `holders`, `assignable`, `editable` and `deletable`. The last three are computed
   per caller by the same rules as the write paths, so the web keeps no copy of them. The default role counts as in
   use: it cannot be deleted while it is the default.
8. **Writes**, all under `access.manage`, each conditional on the role's version:
   - `POST /access/roles`: create (`{ id, name, description, permissions }`), 201; 409 `role_exists`.
   - `POST /access/roles/{roleId}`: update (`{ name, description, permissions, version }`), 200.
   - `POST /access/roles/{roleId}/delete`: delete (`{ version }`), 204.
   - Refusals:
     - 409 `role_changed`: the version is out of date;
     - 409 `role_in_use`: someone holds the role;
     - 409 `role_protected` or `role_built_in`: the role cannot take that change;
     - 400 `reserved_permission`: a role may not hold a reserved permission;
     - 403 `forbidden`: the change would escalate.
9. **The default role is data.** `SYSTEM` / `ACCESS_DEFAULTS` holds `default_role_id`. It cannot be the protected role.
   `POST /access/defaults` (`{ defaultRoleId }`) changes it. With no record, the default is `viewer`.
10. **Scope is deployment-wide.** A per-world scope is a later option. There is no field for it now.
11. **Audit.** Each role record keeps who changed it last and when. The identity is pseudonymous, and identity deletion
    keeps it, as it keeps `updated_by` on profiles.

## Consequences

- The owner can add roles, change what a built-in role grants, and choose the default role without a deploy.
- A request costs one more consistent read of one item, for its role.
- A role that someone holds cannot be deleted. A role deleted in a race with an assignment leaves its holder with
  only their direct grants, which grants nothing they did not have.
- World roles for player names are a separate decision (Wave 3).
