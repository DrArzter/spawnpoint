# ADR-0071 — Delete an Identity and every record that names it

- Status: Accepted — implemented (#136): `POST /access/identities/{identityId}/delete`
- Date: 2026-11-21
- Milestone: M4
- Extends: [ADR-0036](0036-observed-visitors-and-owner-approved-access.md),
  [ADR-0045](0045-provider-neutral-login-sessions.md), [ADR-0057](0057-link-login-providers-through-the-current-identity.md),
  [ADR-0061](0061-connect-agents-through-oauth.md)
- Relates: [ADR-0063](0063-run-console-commands-through-one-ssm-document.md),
  [ADR-0064](0064-let-a-world-carry-game-settings.md), [ADR-0066](0066-keep-a-world-whitelist-on-its-record.md)

## Context

An Owner can approve a person, change their role and dismiss a request. An Owner cannot remove a person. The only
way out was to set the role to Viewer. The person's records stayed in `spawnpoint-access` with their names, handles,
email addresses and Telegram ids. UK GDPR Article 17 and the storage-limitation principle ask us to be able to erase
them.

What a person leaves in the access table (one table, `pk`/`sk`, one index `gsi1`, TTL on `ttl`):

- the Identity profile `IDENTITY#<id> / PROFILE`, its `SUBSCRIPTIONS`, `APPEARANCE` and `LOGIN_PROVIDER#<p>` items;
- one linked account per login provider (`TELEGRAM#<id>` or `ACCOUNT#<provider>#<subject>` / `ACCOUNT`), found by
  `gsi1pk = IDENTITY#<id>`;
- a password credential `CREDENTIAL#EMAIL#<email> / PASSWORD` when the password provider is linked;
- browser login sessions `LOGIN_SESSION#<id> / REFRESH`, found by `gsi1pk = ACCOUNT#<provider>#<subject>`, kept
  after logout as `REVOKED` until their 30-day TTL;
- OAuth codes and refresh tokens `OAUTH#CODE|REFRESH#<hash>`, keyed by hash only, with `identity_id` as an attribute
  and no index. Each rotation leaves a `ROTATED` item until its 30-day TTL;
- email action tokens, access invitations (as invitee or sender), player invitation events with no TTL, console
  command records (90 days) and backup download records (365 days) that copy the display name, and the
  `SYSTEM / BOOTSTRAP` claim when the person is the bootstrap Owner.

Outside the table, the current world record in the releases bucket copies the display name into `updated_by` of its
game settings (ADR-0064) and its whitelist (ADR-0066).

Facts that shape the design:

- Identity resolution reads the account item and then the profile. A missing profile means "no access" on every
  surface: the HTTP dispatcher, MCP and the bot.
- Bearer access tokens and OAuth access tokens live 15 minutes and carry no role. Every authorised call resolves the
  Identity again.
- Two Owners who delete each other at the same time must not leave the project with no Owner. The bootstrap claim
  is one-time, so the product has no recovery path.
- A claimed bootstrap makes the configured Telegram account an ordinary visitor, also when its Owner was deleted.

## Decision

An Owner deletes another person with `POST /access/identities/{identityId}/delete`, with no body. It is declared in
`access-routes.ts` as `permissionRoute("access.manage", …)` and goes through the shared dispatcher. The new
functional module `identity-deletion.ts` implements it. The method is `POST` because every access change is
`POST …/<verb>` and API Gateway CORS allows only `GET, POST, PUT, OPTIONS`.

The handler refuses in this order:

1. The caller is the target: `409 self_delete_forbidden`.
2. The target has no profile: `204`. A repeat call ends here and writes no audit line.
3. The target is an Owner and the caller does not hold `access.owner.grant`: `403 forbidden`. This is a
   payload-dependent escalation, the same as granting the Owner role.
4. The target is an Owner and the index counts one active Owner: `409 last_owner`.

The deletion is a hard delete in four steps. Each step can run again.

1. **Read.** The identity partition (consistent), the linked accounts from the index and from the partition's
   provider markers, the password credential that names the same subject, and one paginated Scan for records that
   have no index by identity.
2. **Sweep 1.** Delete every login session of every linked account, every OAuth code and refresh token, and every
   email action token of the person. After this step, no credential can obtain a new access token.
3. **Commit.** One `TransactWriteItems`:
   - `ConditionCheck` the caller's profile: still `ACTIVE`, and still `owner` when the target is an Owner;
   - `Delete` every item of `IDENTITY#<id>`; the profile only while it exists with the role read in step 1;
   - `Delete` each linked account while `identity_id = :id`;
   - `Delete` the password credential while `subject = :subject`;
   - when the target is the bootstrap Owner, `Update` `SYSTEM / BOOTSTRAP` to remove `telegram_id` and
     `identity_id` and to set `owner_removed_at`. The item stays, so the bootstrap can never run again.

   Cancellation reasons map to answers: the caller check failed → `409 caller_changed`; the profile is gone →
   `204`; the profile, an account or the credential changed → `409 identity_changed`; a transaction conflict →
   `409 deletion_conflict`. All of them are safe to retry. Once this step commits, the person has no access anywhere.
4. **Sweep 2.** Delete login sessions again (a sign-in can race step 2). Delete partition items and linked accounts
   that appeared after step 1. Scan again, then: delete OAuth and email action items that appeared since step 1, the
   access invitation where the person is the invitee and its proofs, and the player invitation events they sent;
   revoke the pending access invitations they created; remove `display_name` from their console command and backup
   download records. Rewrite the current world records whose `updated_by` names the person to the name
   "Deleted user", through `S3WorldRepository` with an ETag guard. A record that changes during the rewrite is read
   again, at most three times. A failure in this step is logged and the call still answers `204`, because access is
   already gone and the rest is pseudonymous or expires.

The pseudonymous id stays where it is: `identity_id` on console and download records, `identity:<uuid>` in S3,
Step Functions and CodeBuild, `created_by`, `approved_by` and `updated_by` on other people's records, and the
recipient list of player invitations other people sent.

The console API answers `displayName: null` for a console command whose sender was deleted. The console shows
"Deleted user".

The OAuth token endpoint refuses `invalid_grant` when the Identity of a code or refresh token no longer resolves.

The handler writes one structured log line to the access API log group (14 days):

```json
{"event":"identity_deleted","actorIdentityId":"<uuid>","deletedIdentityId":"<uuid>","roleId":"operator",
 "removed":{"accounts":2,"credentials":1,"loginSessions":2,"oauth":3,"emailActions":1,"invitations":2,"playerInvitations":1},
 "revoked":{"accessInvitations":1},"anonymised":{"console":1,"downloads":1,"worlds":1,"bootstrap":0},
 "sweep2":"complete","at":"2026-11-21T10:00:00.000Z"}
```

It holds the actor's Identity id, because it is the accountability record and the actor is a current Owner. It
holds no name, handle, email address, provider, provider subject, Telegram id or IP address.

The access API Lambda gets `dynamodb:DeleteItem` and `dynamodb:ConditionCheckItem` on the access table, and
`dynamodb:Scan` on the table only, not on its index. DynamoDB authorises each item of a transaction by its own
action, so the caller's `ConditionCheck` needs `dynamodb:ConditionCheckItem`. Its current S3 rights already cover the world-record rewrite.

MCP does not expose the operation. The OAuth scopes (`spawnpoint.read`, `spawnpoint.operate`) do not cover access
administration, and erasure is an action a person takes in the console after typing the name. The only MCP impact:
a deleted person's agent connections stop working.

The console shows a `Delete user` action in each member row's overflow. It opens the shared confirmation dialog
with a typed confirmation of the member's display name. The action is absent for the caller's own row, and absent
for an Owner row when the caller does not hold `access.owner.grant`.

## Consequences

**Good**

- One action removes a person from every store that can identify them. Erasure requests can be met in the product.
- The commit step is atomic and serialisable, so the last-Owner rule holds under concurrent deletes.
- A signed-in person loses access on their next request. A cookie session gets `401`. A bearer token gets
  `403 access_not_granted` until it expires. MCP gets `401`. The bot refuses commands.
- Records about other people stay valid. Console history and backup download records keep an id that now resolves
  to nobody.

**Bad, or risky**

- The access API Lambda can delete items in, and scan, the access table. Scan is needed because OAuth credentials,
  email action tokens and player invitation events have no index by identity.
- The Identity id stays in other records. After deletion it maps to no person in Spawnpoint.
- A deletion that loses a race (for example, two Owners who delete each other) can already have ended the target's
  sessions in sweep 1. The target keeps their access and signs in again.
- A crash between step 3 and step 4 can leave a login session created during step 2. It no longer grants access
  and expires by TTL within 30 days. A repeat call cannot find it, because the account keys are gone.
- Point-in-time recovery keeps deleted items for up to 35 days. Erasure is complete in backups only after that.
- Copies we cannot delete per person: old versions of world records in the versioned releases bucket (no
  noncurrent expiry today), Step Functions execution history (90 days), and the notifier and bot log groups. These
  need retention rules, not a delete step.
- A deleted person who signs in again becomes a new observed visitor (ADR-0036), not a restored member.

**Mitigations**

- The Scan runs only inside the deletion handler, paginated, with a filter on the Identity id and the person's
  provider subjects. The access directory is small.
- A test holds the log line to the keys above and checks that it holds no fixture name, email, subject or
  Telegram id.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Soft delete (`status = DELETED`) | Keeps names and emails, so it does not erase. `resolveIdentity` does not check the status, so access would stay open. |
| One transaction for everything | A person can hold thousands of rotated OAuth items. A transaction takes 100. |
| `DELETE /access/identities/{id}` | Every other access change is `POST …/{verb}`. API Gateway CORS allows `GET, POST, PUT, OPTIONS` only. |
| Add a `gsi1` entry to OAuth and email action items instead of a Scan | Correct long term, but old items stay invisible until their TTL. It can follow later and shrink the Scan. |
| Expose `delete_identity` over MCP | No admin scope exists. Erasure needs a person in the loop. |
| Delete the `SYSTEM / BOOTSTRAP` item with the bootstrap Owner | The configured Telegram account would claim Owner again on its next sign-in. |
| A permanent `AUDIT#identity-deletion` item | Not needed now. The log line is enough for the current size; the item can follow with the same fields. |
| Answer `207` or `500` when sweep 2 fails | The person has no access after the commit, so a retry prompt adds nothing. The log line records `sweep2: incomplete`. |

## Still open

The owner has not yet answered these three questions. The decision above follows the recommendation for each:

- Q-P1. Is a 14-day log line enough as the audit trail, or is a permanent `AUDIT#identity-deletion` item needed?
  May the line hold the actor's Identity id? Recommended: the log line, with the actor id.
- Q-P2. Revoke the pending access invitations that the deleted person created? Recommended: yes.
- Q-P3. Answer `204` when sweep 2 fails after the commit? Recommended: yes, and log it.

Later work:

- Expire noncurrent versions under `worlds/` in the releases bucket, and stop storing names in world records.
  This is a later infrastructure slice.
- Delete unapproved visitors, offer self-service deletion, and state the 35-day backup residue in the privacy notice.
