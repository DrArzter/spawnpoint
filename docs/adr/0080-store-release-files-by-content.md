# ADR-0080 — Store release files by content, and free them only when no release names them

- Status: Proposed — the readers, the infrastructure, the reconciler, the writer (off), retirement and the sweep (dry run)
  are built. The writer stays off until the readers are deployed. The owner decisions in the table below are defaults that the owner may
  change.
- Date: 2026-11-22
- Milestone: M6
- Amends: [ADR-0008](0008-versioned-mod-releases.md) (where the bytes of a release live),
  [ADR-0052](0052-keep-a-release-while-a-generation-names-it.md) (holders, retirement and the first release cleanup),
  [ADR-0065](0065-hand-out-world-files-as-short-lived-links.md) (a link goes to an object named by its digest)
- Runbook: [release-storage-runbook.md](../release-storage-runbook.md)
- Relates: [ADR-0042](0042-preset-scoped-release-identity.md) (release identity does not change),
  [ADR-0028](0028-update-proposals.md) (candidate releases create the growth),
  [ADR-0030](0030-desired-and-active-release.md), [ADR-0068](0068-normalize-upstream-modpacks-into-releases.md),
  [ADR-0077](0077-pin-extra-mods-on-top-of-an-upstream-modpack.md)

## Context

Each build stores every file of a release again under `releases/<game>/<preset>/<release>/`. Two releases of one preset
share most of their files, and the bytes are stored twice. `DenyReleaseDeletion` in the bucket policy denies every
delete under `releases/*`. So nothing frees these bytes, and ADR-0052 says that nothing may be deleted by age alone.

Facts about today's store (the build design, `incremental.md`, section 2, gives file and line references):

- A manifest names each file by `sha256` and `bytes`. Only the place of the bytes would change.
- `manifest.json` is uploaded last. Its existence is the commit marker. The immutability gate compares
  `{game, release, minecraft_version, loader, runtime, server, client}`.
- The bucket is versioned. Noncurrent versions under `releases/` expire after 30 days.
- A host installs a release by hash (`download-release.sh`) and can reuse a file from a sibling release on the same host.
- A player downloads a pack, or one mod by digest (ADR-0065), through a link that the panel or the bot presigns.

Assumptions (verify before deploy; see "Still to verify"): S3 conditional writes (`If-None-Match: *`) work as announced
in August 2024; a bucket-policy deny does not block a lifecycle expiry; a DynamoDB transaction costs two write units for
each item.

## Decision

1. **Objects.** Each payload file and each pack is an object named by its SHA-256:
   `objects/sha256/<first 2 hex>/<64 hex>`. The key has no file name and no extension. Metadata holds the size and the
   checksum only. The content type is `application/octet-stream`. A download sets its name with
   `ResponseContentDisposition`. A write uses `If-None-Match: *` and `x-amz-checksum-sha256`.
2. **Manifest.** A new manifest has `storage: {layout: "objects-v1"}`. For a mod-set release it also has
   `packs: {server, full}` with `{sha256, bytes}`; `client.sha256` and `client.bytes` exist already. A manifest without
   `storage.layout` is **legacy**. Its readers use the keys of today. **Old releases are not converted.**
3. **Identity does not change.** The key `releases/<game>/<preset>/<release>/manifest.json`, the `MAJOR.MINOR` rule, the
   immutability gate and the commit marker stay as they are. `storage`, `packs`, `mod_index` and `plan.json` are outside
   the gate.
4. **Readers first.** A host keeps an object cache at `${SERVER_DIR}/objects/sha256/<aa>/<digest>`. Its files are owned
   by root, have mode `0444` and enter the cache only after a size and SHA-256 check and a rename. A host copies the JARs
   of a release into the staged `mods/`, checks each copy by hash, and always copies overrides. A hard link
   (`OBJECT_CACHE_STAGE_MODE=link`) is an option that stays off: the container-mount test showed that the image's
   start-up `chown` can make a linked cache object writable by the game user. The full SHA-256 check at start stays the
   default. Link mode and the size-only check need the mount test to pass on a real host with the pinned game image. The panel and the bot presign the object of a digest
   and add an attachment name.
5. **Writer second, behind a flag.** The builder writes `objects-v1` only when a flag is on. The flag is off by default.
   It stays off until the readers are deployed and the configured host runs the new commit.
6. **A reference table.** `spawnpoint-release-refs` (DynamoDB) holds file items, back-references (the owner's "used by"),
   release items and release holders. Holders name who needs a release: a generation (`hold#gen`), the catalog
   (`hold#catalog`), a build (`hold#build`) and a backup (`hold#backup`). Every writer of a generation's release writes
   its holder **before** it writes the record that names the release.
7. **One rule for "may this release be used".** A release with state `retiring` or `retired` is not used for a new
   world, a wipe, a restore or a promotion, even though its manifest still exists. One helper does this check for all
   four paths. A release that the table does not know (legacy, or not yet registered) is usable.
8. **Two proofs before a delete.** An object may be deleted only when **both** are true: its `refs` is `0` under a
   condition, and it has been `condemned` for 14 days; **and** it is absent from the mark set of a complete reconciler
   run that started after `condemned_at`. If any source read fails, nothing is deletable in that run.
9. **Reuse during a delete.** A build waits while a file is `deleting`. It uploads a `deleted` file again and sets it
   back to `live` under the condition `state = deleted`. The sweeper sets `deleted` only after `DeleteObject` succeeds.
10. **Retirement.** Retirement is the only way back-references go away. It is an explicit action with a typed
    confirmation. The steps: set `retiring` (no new holder); run a live check of all world records, pointers and archive
    metadata; set `retired` under the condition `holders = 0`; remove each back-reference. Legacy releases are never
    retired and never deleted.
11. **The reconciler.** A scheduled Lambda in `infra/terraform-operations` marks from the sources of truth, compares with
    the table and with a listing of `objects/`, and reports each difference by class. It ships in **report-only mode**.
    It has no write port and its role has no write or delete right. The sweep is a later step behind a dry-run flag that
    is on by default; real deletes need a repository variable.
12. **Bucket policy.** `DenyReleaseDeletion` on `releases/*` does not change. `DeleteObject` on `objects/*` is denied to
    every principal except the role `spawnpoint-release-reconciler`. `DeleteObjectVersion` on `objects/*` is denied to
    every principal. A lifecycle rule expires noncurrent object versions after 30 days and removes delete markers. No rule
    expires a current object under `objects/`.
13. **Upstream cache.** Cache bytes stay under `upstream/` (60 days). They never live in `objects/`. When a release uses
    them, the builder copies them inside S3 into `objects/` and adds the back-reference.

### Amendments to earlier decisions

- **ADR-0008.** The bytes of a release may live in `objects/` instead of under the release key. The manifest is still
  the immutable record of what the release contains, and it still has the same key.
- **ADR-0052.** The named set of a release gains holders in the table. The rule "keep a release while any generation
  names it" stays. The first cleanup that this ADR allows is retirement (decision 10), which needs `holders = 0` and a
  live check. The existence check also refuses a release in state `retiring` or `retired`.
- **ADR-0065.** A link for one mod or one pack of an `objects-v1` release goes to the object of the digest. The manifest
  of the release must still name the digest, so a digest from another release is refused. The link carries an
  attachment name, so a player does not get a file named by its hex digest.

### Owner decisions

The table gives the defaults that this work takes. The owner may change each of them.

| Question | Default taken | Effect if changed |
| --- | --- | --- |
| Q3 Who retires a release | Only the owner, explicitly, with typed confirmation. No automatic rule | An automatic rule for unapproved ADR-0028 candidates needs a new decision and a new dry-run period |
| Q4 Undo window | 14 days of grace in the table plus 30 days of noncurrent versions: 44 days after the last reference goes | A shorter window frees bytes sooner and cuts the time to find a mistake |
| Q5 "Used by" view in the panel | Not in this work. The back-references make it possible later | A panel view is a separate change |
| Q6 Packs | One `client.zip` for each release, stored as an object. A mod-set release also keeps `server.zip` and `full.zip` | Dropping them needs a change in the publication step |
| Q7 Legacy releases | They stay. `DenyReleaseDeletion` does not change | Removing them needs a change to the bucket policy and a new decision |
| Q8 Alerts | The existing operations alarm path (`infra/terraform-operations`, the fleet alert topic) | Another path needs a new topic and subscription |
| Q9 Bucket policy | Part of this work, for the owner's review. Only the reconciler role may delete under `objects/` | Without it, no object can ever be freed |

## Consequences

**Good**

- A new release stores only its changed files and its packs. A candidate release costs little.
- A host downloads only the digests that it does not hold, and does not hash an unchanged file again after the
  container-mount test passes.
- The table answers "which releases use this file".
- The reconciler is a pure mark-and-sweep without deletes. It is useful from the first day, even if the table is empty.
- An old host fails safely: it cannot find the per-release keys of an `objects-v1` release, stops at the download and
  loads no wrong mods.

**Bad, or risky**

- A second record (the table) can drift from the sources of truth. The reconciler finds drift. It cannot prevent it.
- A writer of a generation's release that does not write a holder could let a release be retired while named.
- If link mode is ever turned on, a hard-linked JAR that the game container changes would change the cached file for
  every release.
- Each new release still adds one client pack. The pack is most of the new bytes.
- The bucket policy now has an exception for one role. A mistake in its name would block all deletes under `objects/`
  (safe) or, with a wrong ARN condition, allow more than intended (unsafe). A test holds the ARN and the role name equal.

**Mitigations**

- Holder first, a contract test over the writers, and the mark as a second proof.
- Cache files are root-owned and `0444`, and the game container receives copies, not links. The start-time hash check
  stays until the container-mount test passes with the real image.
- The sweep is dry-run by default, and at least four weekly dry runs come before the first real delete.
- Point-in-time recovery and deletion protection on the table; a rebuild mode that rewrites the table from the sources.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Pure mark-and-sweep, no table | Cheaper (6-8 days against 12-15), but a build race needs an intent file and a grace period on `LastModified`, and "which releases use this file" needs a scan of all manifests. The reconciler ships first as exactly this, without deletes |
| Delete old releases by age | Destroys the only way to open an archive (ADR-0052) |
| A new manifest `schema_version: 2` | Changes the three `schema_version == 1` checks. A top-level field leaves them as they are |
| Packs under the release key | `DenyReleaseDeletion` would make them impossible to free, and they are most of the new bytes |
| One table entry for each file of each backup | About 1,657 transactional writes for each backup, and hosts would need write access to the table |
| Cache bytes in `objects/` | No release names them, so the reconciler would mark them as orphans |

## Deploy order

1. Apply `infra/terraform-storage` (table, bucket policy, lifecycle). Then apply the other roots that read the table.
2. Deploy the readers: the API, the bot, the world lifecycle Lambda and the host commit. Confirm that the configured
   host runs the new commit.
3. Deploy the reconciler and watch its report. Only then turn on the builder flag.
4. Keep the sweep in dry-run for at least four weekly runs before the first real delete.

## Still to verify

- S3 conditional writes, and that a bucket-policy deny does not block a lifecycle expiry. No AWS call was made in this
  work.
- The DynamoDB write units of a transaction.
- That the container's start-up does not change a hard-linked file on a real host (the container-mount test, with the
  pinned game image).
- The full list of writers of a generation's release.
