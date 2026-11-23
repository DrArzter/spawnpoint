# Runbook: content-addressed release storage

This runbook covers [ADR-0080](adr/0080-store-release-files-by-content.md). Read the ADR first. Commands that change
AWS need the owner. This runbook does not replace the general [runbook](runbook.md).

## 1. What runs where

| Part | Where | Default |
| --- | --- | --- |
| Reference table `spawnpoint-release-refs` | `infra/terraform-storage` | On |
| Builder writer for `objects-v1` | `infra/terraform-releases`, variable `release_storage_layout` | `legacy` (off) |
| Reconciler (report, then sweep) | `infra/terraform-operations`, Lambda `spawnpoint-release-reconciler`, weekly | Report only; sweep in dry run |
| Retirement | Lambda `spawnpoint-release-retirement`, started by the API | Owner only, typed confirmation |
| Host object cache | `${SERVER_DIR}/objects/sha256/` on each host | On for `objects-v1` releases |

## 2. Deploy order

Follow this order. Do not skip a step.

1. Apply `infra/terraform-storage`. It creates the table, the bucket policy and the lifecycle rules.
2. Apply the other roots that read or write the table: `terraform-releases`, `terraform-access-api`,
   `terraform-operations` (it also lets the game host write backup holders), `terraform-bot` and `terraform` (the host role).
   - If the table does not exist, creating a world, a wipe, a restore and a promotion all fail. This is intended.
   - The builder's catalog step writes holders even while the layout is `legacy`. A build stops at the catalog step if
     the table or the builder's access is missing.
3. Deploy the application commit to the configured host. Check that the host runs it (`update-checkout.sh` can keep an
   old checkout; its warning names the reason).
4. Register the legacy releases (section 3).
5. Run the reconciler once by hand and read the report (section 4).
6. Only then change `release_storage_layout` to `objects-v1` (section 5).
7. Keep the sweep in dry run for at least four weekly runs before the first real delete (section 7).

## 3. Register legacy releases

Legacy releases are never deleted. Registering them in the table makes sure that nothing treats them as unknown.

```
RELEASE_BUCKET=<bucket> BACKUP_BUCKET=<bucket> node lambdas/tools/register-legacy-releases.ts            # dry run: prints the plan
RELEASE_BUCKET=<bucket> BACKUP_BUCKET=<bucket> node lambdas/tools/register-legacy-releases.ts --apply    # writes
```

- The tool writes no file reference. It skips releases with an `objects-v1` manifest and reports them.
- It writes the backup holders (`hold#backup#<key>#<versionId>`, role `backup`) for every archive version whose release
  it can resolve. It uses the same rule as the reconciler. A second run writes nothing new.
- An archive with no release metadata and no generation id in its key gets no holder. The tool prints
  `report archive_without_release` for it.
- It reports each record that it cannot read, and each archive that names a release but cannot be resolved. Fix those first.

## 4. Read the reconciler report

Run the Lambda by hand: invoke `spawnpoint-release-reconciler` with `{}`. The weekly schedule does the same.

| Class | Meaning | Action |
| --- | --- | --- |
| `missing_object` | A live manifest names an object that is not in S3 | Dangerous. Alarm. Re-run the build of that release (heal mode restores it from the local file) or restore the noncurrent version |
| `missing_holder`, `missing_reference` | The table lacks a holder or a reference that a source needs | Dangerous. Alarm. Find the writer that skipped it. Do not retire or sweep until it is fixed |
| `extra_reference`, `counter_drift` | The table has more than the sources justify | Report only. Check after a retry, then raise a fix |
| `orphan_object` | An object that no manifest names | The sweep condemns it in a real run |
| `stuck_deleting` | A delete did not finish | The next complete run finishes or reverts it |
| `unregistered_release` | A release has no table item | Run section 3 |
| `archive_without_release` | A backup archive (any version) with no release metadata and no generation id in its key. It predates release recording, so it holds no release | Informational. Not dangerous, not a failure. No action. Legacy releases are never swept |

A new backup gets its holder from the host, right after the upload (`hold-backup-release.sh`). If that write fails,
the archive stays and the stop succeeds. The host log has `backup_holder_missing key=... version=...`. The reconciler
then reports a `missing_holder` for it. Run section 3 with `--apply` to write it. Do not retire or sweep until it is
fixed. A common cause is a release that is not registered yet (run section 3) or not live.

An archive that has release metadata or a generation id but whose release cannot be resolved is a failure
(`release_unresolved`). The run is then incomplete. A world with no legacy pointer is not a failure: the reconciler
reads the pointer only when the listing of `worlds/` holds it. A listed pointer that S3 refuses to read is a failure.

An `Incomplete` alarm means that one source could not be read. The report is then not a pass, and nothing is
swept in that run. Check `/aws/lambda/spawnpoint-release-reconciler`.

## 5. Turn on the writer

1. Confirm section 2 is done and the reconciler report has no dangerous class.
2. Set the repository variable `SPAWNPOINT_RELEASE_STORAGE_LAYOUT` to `objects-v1` and run the production deploy. It reaches `release_storage_layout` in `infra/terraform-releases`; unset means `legacy`.
3. Build one release of a small preset. Read the build log lines: `layout=objects-v1`, `objects_total`,
   `objects_created`, `objects_reused`, `bytes_uploaded` and `writer_seconds`.
4. Start a world on it from a host that runs the new commit. Read `downloaded=`, `fetched=` and `seconds=`.
5. To go back, set the repository variable to `legacy` (or delete it) and deploy again. Releases that exist stay readable.

An old host that meets an `objects-v1` release stops at the download and loads no mods. The start log names the cause.

## 6. Retire a release

Only the owner can do this. A retired release cannot be used for a new world, a wipe, a restore or a promotion.
Its manifest stays as history.

1. Check the release in the panel: no world may need it. The retirement checks this again and refuses if any world
   record, pointer or archive (current or older versions) names the release.
2. Send `POST /games/<game>/presets/<preset>/releases/<version>/retire` with the body
   `{"confirmation": "<game>/<preset>@<version>"}`. The text must match exactly.
3. The call answers `202`. The work runs in the Lambda `spawnpoint-release-retirement`. Read its log for the result.
4. Legacy releases and the latest release of a preset are refused.
5. The release leaves the preset catalog. Objects that no other release names become `condemned`. They are deleted
   only by the sweep, at least 14 days later.

## 7. The sweep

The sweep is part of the reconciler. It is in dry run unless the Lambda variable `RELEASE_SWEEP_DRY_RUN` is exactly
`false`. It is set by the Terraform variable `release_sweep_dry_run` (default `true`).

An object is deleted only when all of these hold:

- its `refs` is 0 and it has been `condemned` for at least 14 days;
- no live manifest names it in a complete run that started after it was condemned;
- no back-reference remains.

Steps for one object: set `deleting`; delete the object; set `deleted` only after the delete worked.

Before the first real delete:

1. Read at least four weekly dry runs. Compare `SweepCandidates` with what you expect.
2. Check that the reports were complete and had no dangerous class.
3. Set `release_sweep_dry_run = false` and apply. Watch the next run and the `SweepFailed` alarm.

Undo window: 14 days of grace plus 30 days of noncurrent versions. To undo a delete within 30 days, copy the
noncurrent version back to the same key (the bucket policy denies `DeleteObjectVersion` to everyone) and set the table
item back with a build or with the reconciler's repair. Ask the owner before you do this by hand.

## 8. Host object cache

- Files in `objects/` are root-owned and mode `0444`. A mod reaches the game as a **copy**, checked by hash.
- Hard links (`OBJECT_CACHE_STAGE_MODE=link`) and the size-only start check (`OBJECT_CACHE_START_CHECK=size`) stay off.
  The mount test with the stand-in image showed that the image's start-up `chown` can make a linked file writable by the
  game user. Before you turn either on, run
  `OBJECT_MOUNT_TEST_MODE=link OBJECT_MOUNT_TEST_IMAGE=<pinned game image> bash server/tests/object-cache-mount-test.sh`
  on a host, and turn them on only when it passes.
- Eviction runs after a download and removes the oldest unlinked files when free space is low. A file that an installed
  payload directory links is never removed, so eviction frees little until old payload directories are removed.

## 9. Read the store by hand

Under `objects-v1` a file is an object named by its SHA-256: `objects/sha256/<first 2 hex>/<64 hex>`. The key has no
file name, and one object can belong to many releases. The release key holds only `manifest.json`, which maps each name
to its object. Use the panel's Releases tab for one world's files. To read the bucket directly, use
`scripts/release-files.sh`. It only lists keys and reads manifests.

```
scripts/release-files.sh show minecraft prominence 45059711263.1   # every file: kind, path, bytes, SHA-256, S3 key
scripts/release-files.sh find minecraft backpacks                   # the releases with a file whose name contains the text
scripts/release-files.sh object 3f9a…e7                             # is it stored, and which releases and files name it
```

The output is tab-separated, with a header line, and aligned on a terminal. The tool reads legacy releases too: it
prints their own keys, and the packs beside them. `object` reads every manifest in the bucket, so it takes longer when
there are many releases.

## 10. Measurements

These lines exist so that the numbers in the design can be checked. Record each reading in
[measurements.md](measurements.md) with the date, the release and the instance type.

| Reading | Where |
| --- | --- |
| Build: objects uploaded, reused, bytes, writer time | Builder log: `objects_created`, `objects_reused`, `bytes_uploaded`, `writer_seconds` |
| Host: files fetched, download time | `download-release.sh` output: `downloaded=`, `fetched=`, `seconds=`; `step=` lines of `start-session.sh` |
| Reconciler: drift and sweep | CloudWatch namespace `Spawnpoint/ReleaseReconciler` |
| Real size of `client.zip` and the share of changed files between releases | The release plan (`plan.json`) and the manifests |

## 11. Still to verify with AWS

No AWS call was made while this was built. Verify before you rely on it:

- S3 conditional writes (`If-None-Match: *`) on `PutObject`, and the explicit `ChecksumSHA256` header for a stream body.
- Whether `CopyObject` accepts `If-None-Match`. The writer falls back to uploading the local file.
- That a bucket-policy deny does not block a lifecycle expiry of noncurrent object versions.
- The write units of a DynamoDB transaction.
- The container-mount test with the pinned game image.
