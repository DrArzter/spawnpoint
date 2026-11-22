// Registers the releases that exist before the reference table as legacy ones
// and adds the holders that name them today (ADR-0080, design 4.9).
// DRY RUN by default: it prints the plan and writes nothing. It never writes a
// file reference, and nothing for a release whose manifest is objects-v1.
//
//   RELEASE_BUCKET=<bucket> BACKUP_BUCKET=<bucket> node lambdas/tools/register-legacy-releases.ts           print the plan
//   RELEASE_BUCKET=<bucket> BACKUP_BUCKET=<bucket> node lambdas/tools/register-legacy-releases.ts --apply   write it
//
// Backup holders use the reconciler's own resolution (resolveArchive); an archive
// without a release gets none. Needs AWS credentials and AWS_REGION;
// AWS_PROFILE and RELEASE_REFS_TABLE are optional.

import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { candidateReleases, planLegacyRegistration, type KnownRelease, type ManifestListing, type PointerSource, type RegistrationInput } from "../src/control-plane/legacy-registration.ts";
import { ARCHIVE_KEY, s3BackupBucketReader } from "../src/control-plane/s3-release-marks.ts";
import type { ArchiveSource } from "../src/control-plane/release-reconciler.ts";
import { parsePresetCatalog } from "../src/control-plane/preset-catalog.ts";
import { releaseItemPk } from "../src/control-plane/release-objects.ts";
import { ReleaseRefs } from "../src/control-plane/release-refs.ts";
import { parseLegacyReleaseState, parseReleaseState } from "../src/control-plane/release-state.ts";
import { parseWorldRecord, type WorldRecord } from "../src/control-plane/world-registry.ts";

const apply = process.argv.includes("--apply");
const bucket = process.env.RELEASE_BUCKET;
const backupBucket = process.env.BACKUP_BUCKET;
if (!bucket || !backupBucket) {
  console.error("error: RELEASE_BUCKET and BACKUP_BUCKET are required");
  process.exit(2);
}
if (process.argv.slice(2).some((argument) => argument !== "--apply")) {
  console.error("usage: register-legacy-releases.ts [--apply]");
  process.exit(2);
}

const s3 = new S3Client({});
const refs = new ReleaseRefs(DynamoDBDocumentClient.from(new DynamoDBClient({})));
const unreadable: Array<{ source: string; subject: string; reason: string }> = [];

async function keys(prefix: string, pattern: RegExp): Promise<RegExpExecArray[]> {
  const found: RegExpExecArray[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) })); // NOSONAR paginated: the next token comes from the previous page
    for (const object of page.Contents ?? []) {
      const match = object.Key === undefined ? null : pattern.exec(object.Key);
      if (match) found.push(match);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return found;
}

/** The parsed object, or null when it is missing. A body that is not JSON is reported and returns null. */
async function json(key: string): Promise<unknown> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await response.Body!.transformToString()) as unknown;
  } catch (error) {
    if (error instanceof NoSuchKey || (error instanceof Error && error.name === "NoSuchKey")) return null;
    unreadable.push({ source: "object", subject: key, reason: error instanceof Error ? error.name : "unknown error" });
    return null;
  }
}

const manifests: ManifestListing[] = [];
for (const match of await keys("releases/", /^releases\/([a-z0-9][a-z0-9-]{0,31})\/([a-z0-9][a-z0-9-]{0,31})\/(\d+\.\d+)\/manifest\.json$/)) {
  const manifest = await json(match[0]); // NOSONAR one at a time: the listing is small
  if (manifest !== null) manifests.push({ ref: { gameId: match[1]!, presetId: match[2]!, release: match[3]! }, manifest });
}

const catalogs: Array<RegistrationInput["catalogs"][number]> = [];
for (const match of await keys("presets/", /^presets\/([a-z0-9][a-z0-9-]{0,31})\/catalog\.json$/)) {
  const value = await json(match[0]); // NOSONAR one at a time: one catalog per game
  if (value === null) continue;
  const presets = parsePresetCatalog(value, match[1]!);
  if (presets === null) unreadable.push({ source: "catalog", subject: match[0], reason: "not a valid preset catalog" });
  else catalogs.push({ gameId: match[1]!, presets: presets.map((preset) => ({ id: preset.id, releases: preset.releases })) });
}

const worlds: WorldRecord[] = [];
const pointers: Array<{ worldId: string; state: NonNullable<ReturnType<typeof parseReleaseState>> }> = [];
const legacyPointers: PointerSource[] = [];
for (const match of await keys("worlds/", /^worlds\/([a-z0-9][a-z0-9-]{0,31})\/world\.json$/)) {
  const value = await json(match[0]); // NOSONAR one world at a time
  if (value === null) continue;
  const record = parseWorldRecord(value);
  if (record === null || record.worldId !== match[1]) {
    unreadable.push({ source: "world record", subject: match[0], reason: "not a valid world record" });
    continue;
  }
  worlds.push(record);
  for (const generation of [record.currentGeneration, ...record.previousGenerations]) {
    const ref = { worldId: record.worldId, generationId: generation.id };
    const key = `worlds/${record.worldId}/generations/${generation.id}/release.json`;
    const pointer = await json(key); // NOSONAR one pointer at a time
    if (pointer === null) continue;
    const state = parseReleaseState(pointer, ref);
    if (state === null) unreadable.push({ source: "release pointer", subject: key, reason: "not a valid release pointer" });
    else pointers.push({ worldId: record.worldId, state });
  }
  const legacyKey = `worlds/${record.worldId}/release.json`;
  const legacy = await json(legacyKey); // NOSONAR in order with the world record read above
  if (legacy === null) continue;
  const state = parseLegacyReleaseState(legacy, { worldId: record.worldId, generationId: record.currentGeneration.id }, new Date().toISOString());
  if (state === null) unreadable.push({ source: "release pointer", subject: legacyKey, reason: "not a valid legacy release pointer" });
  else legacyPointers.push({ worldId: record.worldId, generationId: "legacy", desired: state.desiredRelease, active: state.activeRelease, runs: [], prePromotion: null });
}

// Every version of every archive. A version that cannot be read is reported, never skipped.
const archives: ArchiveSource[] = [];
const backups = s3BackupBucketReader(s3, backupBucket);
for (const version of (await backups.listVersions("worlds/")).filter((entry) => ARCHIVE_KEY.test(entry.key))) {
  try {
    const metadata = await backups.head(version.key, version.versionId); // NOSONAR one at a time: the listing is small
    if (metadata !== null) archives.push({ worldId: ARCHIVE_KEY.exec(version.key)![1]!, key: version.key, versionId: version.versionId, metadata });
  } catch (error) {
    unreadable.push({ source: "archive", subject: `${version.key}#${version.versionId}`, reason: error instanceof Error ? error.name : "unknown error" });
  }
}

const known = new Map<string, KnownRelease>();
for (const ref of candidateReleases({ manifests, catalogs, worlds, pointers, legacyPointers, archives })) {
  const item = await refs.readRelease(ref); // NOSONAR one consistent read at a time
  if (item !== null) known.set(releaseItemPk(ref.gameId, ref.presetId, ref.release), { layout: item.layout, state: item.state });
}

const plan = planLegacyRegistration({ manifests, known, catalogs, worlds, pointers, legacyPointers, archives, unreadable });
const name = (ref: { gameId: string; presetId: string; release: string }) => `${ref.gameId}/${ref.presetId}/${ref.release}`;

console.log(apply ? "mode=apply" : "mode=dry-run (nothing is written; pass --apply to write)");
for (const ref of plan.register) console.log(`register legacy live  ${name(ref)}`);
for (const holder of plan.holders) console.log(`hold                  ${name(holder.ref)}  hold#${holder.key}  ${holder.roles.join(",")}`);
for (const line of plan.report) console.log(`report ${line.kind}  ${line.subject}  ${line.reason}`);

let failed = plan.report.some((line) => line.kind === "unreadable");
if (apply) {
  for (const ref of plan.register) {
    try {
      await refs.registerLegacy(ref); // NOSONAR ordered: a holder needs its release item
    } catch (error) {
      failed = true;
      console.error(`error: ${name(ref)} was not registered: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  for (const holder of plan.holders) {
    try {
      if (!await refs.holds(holder.ref, holder.key, holder.roles)) await refs.hold(holder.ref, holder.key, holder.roles); // NOSONAR ordered writes
    } catch (error) {
      failed = true;
      console.error(`error: ${name(holder.ref)} hold#${holder.key} was not written: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}
console.log(`registered=${plan.register.length} holders=${plan.holders.length} reported=${plan.report.length}`);
process.exit(failed ? 1 : 0);
