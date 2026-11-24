import assert from "node:assert/strict";
import test from "node:test";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { dynamoRetirementTable } from "../src/control-plane/dynamo-release-retirement.ts";
import { fileItemPk, ITEM_META_SK, releaseItemPk } from "../src/control-plane/release-objects.ts";
import { ReleaseRefs } from "../src/control-plane/dynamo-release-refs.ts";
import type { MarkInput } from "../src/control-plane/release-reconciler.ts";
import {
  catalogWithoutRelease, inPool, manifestDigests, parseRetirementRequest, retireRelease, retirementConfirmation,
  type CatalogStore, type RetirementDeps, type RetirementTable,
} from "../src/control-plane/release-retirement.ts";
import { checkReleaseUsable } from "../src/control-plane/release-usable.ts";
import type { ReleaseState } from "../src/control-plane/release-state.ts";
import { liveSourceReader, s3CatalogStore } from "../src/control-plane/s3-release-retirement.ts";
import type { BackupBucketReader, ReleaseBucketReader } from "../src/control-plane/s3-release-marks.ts";
import { worldRecordDocument, type WorldRecord } from "../src/control-plane/world-registry.ts";
import { retire } from "../src/handlers/release-retirement.ts";
import { FakeRefsTable } from "./fake-refs-table.ts";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const OLD = "2026-10-01T00:00:00.000Z";
const GEN = `gen-${"a".repeat(32)}`;
const OLD_GEN = `gen-${"b".repeat(32)}`;
const ARCHIVE = `worlds/world/archives/world-${GEN}-20261101T000000Z-${"c".repeat(64)}.tar.zst`;
const REF = { gameId: "minecraft", presetId: "prominence", release: "1.4" } as const;
const ID = releaseItemPk(REF.gameId, REF.presetId, REF.release);
const OTHER_ID = releaseItemPk(REF.gameId, REF.presetId, "1.5");
const CONFIRMATION = "minecraft/prominence@1.4";
const REQUEST = { ...REF, confirmation: CONFIRMATION, requestedBy: "identity:owner" };

function digest(n: number): string {
  return n.toString(16).padStart(64, "0");
}

// Digests 1 and 2 are shared with release 1.5; 3 to 6 belong to 1.4 alone.
const MANIFEST = {
  storage: { layout: "objects-v1" },
  server: { mods: [{ file: "a.jar", sha256: digest(1), bytes: 1 }], overrides: [{ path: "config/x.toml", sha256: digest(2), bytes: 1 }] },
  client: { kind: "mod-set", sha256: digest(3), bytes: 1, mods: [{ file: "c.jar", sha256: digest(4), bytes: 1 }] },
  packs: { server: { sha256: digest(5), bytes: 1 }, full: { sha256: digest(6), bytes: 1 } },
};
const DIGESTS = [1, 2, 3, 4, 5, 6].map(digest);
const SHARED = [1, 2].map(digest);
const OWN = [3, 4, 5, 6].map(digest);

const RECORD: WorldRecord = {
  worldId: "world", gameId: "minecraft", displayName: "World", status: "active", placement: "configured", connectivity: "zerotier",
  preset: { id: "prominence", repository: "https://github.com/example/presets", commit: "0".repeat(40), profileDigest: "1".repeat(64) },
  currentGeneration: { id: GEN, release: "1.3", createdAt: "2026-08-01T00:00:00.000Z", source: { kind: "preset" } },
  previousGenerations: [],
};

const POINTER: ReleaseState = {
  worldId: "world", generationId: GEN, desiredRelease: "1.5", activeRelease: "1.5", updatedAt: "2026-11-01T00:00:00.000Z",
  updatedBy: "op-1", source: "promote-commit",
};

function catalogDocument(extra: Record<string, unknown> = {}) {
  return {
    schema_version: 2, game: "minecraft", source: { repository: "https://github.com/example/presets", commit: "0".repeat(40) },
    presets: [{
      id: "prominence", display_name: "Prominence", profile_digest: "1".repeat(64), build_status: "ready", latest_release: "1.5",
      releases: ["1.3", "1.4", "1.5"],
      built_from: { "1.4": { profile_digest: "1".repeat(64), source_commit: "0".repeat(40) }, "1.5": { profile_digest: "1".repeat(64), source_commit: "0".repeat(40) } },
      ...extra,
    }],
  };
}

function catalogPresets(document: unknown) {
  return (document as { presets: Array<{ releases: string[]; built_from: Record<string, unknown> }> }).presets[0]!;
}

function markInput(overrides: Partial<MarkInput> = {}): MarkInput {
  return {
    manifestsListed: true, manifests: [], worlds: [RECORD], pointers: [{ worldId: "world", state: POINTER }],
    archives: [{ worldId: "world", key: ARCHIVE, versionId: "v1", metadata: { release: "1.5", releaseSource: "active", storedAt: "2026-11-01T00:00:00.000Z" } }],
    catalogs: [{ gameId: "minecraft", presets: [{
      id: "prominence", displayName: "Prominence", gameId: "minecraft", repository: "r", commit: "0".repeat(40), profileDigest: "1".repeat(64),
      releases: ["1.3", "1.4", "1.5"], latestRelease: "1.5", buildStatus: "ready",
    }] }],
    retired: new Set(), failures: [],
    ...overrides,
  };
}

class FakeCatalogs implements CatalogStore {
  document: unknown = catalogDocument();
  etag = 1;
  writes = 0;
  /** How many writes lose the race before one succeeds. */
  lose = 0;
  beforeWrite: (() => void) | undefined;
  async read() {
    return { document: structuredClone(this.document), etag: `"${this.etag}"` };
  }
  async write(_gameId: string, document: unknown, etag: string) {
    this.beforeWrite?.();
    if (this.lose > 0 || etag !== `"${this.etag}"`) {
      if (this.lose > 0) this.lose -= 1;
      this.etag += 1;
      return "lost" as const;
    }
    this.document = structuredClone(document);
    this.etag += 1;
    this.writes += 1;
    return "written" as const;
  }
}

type Setup = Readonly<{
  table: FakeRefsTable;
  catalogs: FakeCatalogs;
  deps: RetirementDeps;
  transitions: string[];
  source: { input: MarkInput; onRead: (() => void) | undefined };
  manifest: { value: unknown };
}>;

function seedTable(table: FakeRefsTable, options: { layout?: "legacy" | "objects"; state?: string; holders?: Array<{ sk: string; addedAt?: string }> } = {}): void {
  const holders = options.holders ?? [
    { sk: "hold#catalog#minecraft", addedAt: OLD },
    { sk: `hold#gen#gone/${OLD_GEN}`, addedAt: OLD },
    { sk: "hold#build#old-build", addedAt: OLD },
  ];
  table.put({ pk: ID, sk: ITEM_META_SK, layout: options.layout ?? "objects", state: options.state ?? "live", holders: holders.length });
  for (const holder of holders) {
    table.put({ pk: ID, sk: holder.sk, roles: new Set(["build"]), ...(holder.addedAt === undefined ? {} : { added_at: holder.addedAt }) });
  }
  table.put({ pk: OTHER_ID, sk: ITEM_META_SK, layout: "objects", state: "live", holders: 1 });
  for (const sha of DIGESTS) {
    const shared = SHARED.includes(sha);
    table.put({ pk: fileItemPk(sha), sk: ITEM_META_SK, state: "live", refs: shared ? 2 : 1, bytes: 1 });
    table.put({ pk: fileItemPk(sha), sk: ID, path: "x", added_at: OLD });
    if (shared) table.put({ pk: fileItemPk(sha), sk: OTHER_ID, path: "x", added_at: OLD });
  }
}

function setup(options: Parameters<typeof seedTable>[1] = {}, input: MarkInput = markInput()): Setup {
  const table = new FakeRefsTable();
  seedTable(table, options);
  const catalogs = new FakeCatalogs();
  const real = dynamoRetirementTable(table as never, "refs");
  const transitions: string[] = [];
  const wrapped: RetirementTable = {
    ...real,
    async transition(ref, from, to, opts) {
      transitions.push(`${from}->${to}`);
      return real.transition(ref, from, to, opts);
    },
  };
  const source = { input, onRead: undefined as (() => void) | undefined };
  const manifest = { value: MANIFEST as unknown };
  const deps: RetirementDeps = {
    table: wrapped,
    readManifest: async () => manifest.value,
    readSources: async () => { source.onRead?.(); return source.input; },
    catalogs,
    now: () => NOW,
  };
  return { table, catalogs, deps, transitions, source, manifest };
}

function release(table: FakeRefsTable) {
  return table.get(ID, ITEM_META_SK)!;
}

function holderItems(table: FakeRefsTable): string[] {
  return [...table.items.values()].filter((item) => item.pk === ID && String(item.sk).startsWith("hold#")).map((item) => String(item.sk));
}

function backReferences(table: FakeRefsTable, sha: string): string[] {
  return [...table.items.values()].filter((item) => item.pk === fileItemPk(sha) && String(item.sk).startsWith("release#")).map((item) => String(item.sk));
}

function snapshot(table: FakeRefsTable): string {
  return JSON.stringify([...table.items.entries()].map(([key, item]) => [key, { ...item, roles: item.roles instanceof Set ? [...item.roles as Set<string>] : item.roles }]).sort());
}

test("the confirmation is exactly game/preset@release", () => {
  assert.equal(retirementConfirmation(REF), "minecraft/prominence@1.4");
});

test("the request parser accepts only the documented input", () => {
  assert.deepEqual(parseRetirementRequest(REQUEST), REQUEST);
  for (const bad of [
    null, [], "x", {}, { ...REQUEST, gameId: "../x" }, { ...REQUEST, presetId: "" }, { ...REQUEST, release: "1" }, { ...REQUEST, release: "1.4.1" },
    { ...REQUEST, confirmation: 1 }, { ...REQUEST, requestedBy: "" }, { ...REQUEST, requestedBy: undefined },
  ]) assert.equal(parseRetirementRequest(bad), null);
});

test("a retirement runs live to retiring to retired, empties the holders and condemns what no release uses", async () => {
  const run = setup();
  const result = await retireRelease(REQUEST, run.deps);
  assert.equal(result.status, "retired");
  assert.deepEqual(run.transitions, ["live->retiring", "retiring->retired"]);
  assert.equal(result.holdersRemoved, 3);
  assert.equal(result.referencesRemoved, 6);
  assert.equal(result.condemned, 4);
  assert.equal(result.catalogChanged, true);
  assert.equal(result.alreadyRetired, false);

  const item = release(run.table);
  assert.equal(item.state, "retired");
  assert.equal(item.holders, 0);
  assert.equal(item.retired_by, "identity:owner");
  assert.equal(typeof item.retired_at, "string");
  assert.deepEqual(holderItems(run.table), []);

  for (const sha of DIGESTS) assert.ok(!backReferences(run.table, sha).includes(ID), "the back-reference is gone");
  for (const sha of SHARED) {
    assert.deepEqual(backReferences(run.table, sha), [OTHER_ID]);
    assert.equal(run.table.get(fileItemPk(sha), ITEM_META_SK)!.refs, 1);
    assert.equal(run.table.get(fileItemPk(sha), ITEM_META_SK)!.state, "live");
    assert.equal(run.table.get(fileItemPk(sha), ITEM_META_SK)!.condemned_at, undefined);
  }
  for (const sha of OWN) {
    const file = run.table.get(fileItemPk(sha), ITEM_META_SK)!;
    assert.equal(file.refs, 0);
    assert.equal(file.state, "condemned");
    assert.equal(file.condemned_at, NOW.toISOString());
  }
  // The other release is not touched.
  assert.equal(run.table.get(OTHER_ID, ITEM_META_SK)!.state, "live");

  const listed = catalogPresets(run.catalogs.document);
  assert.deepEqual(listed.releases, ["1.3", "1.5"]);
  assert.deepEqual(Object.keys(listed.built_from), ["1.5"]);
  assert.equal(run.catalogs.writes, 1);
});

test("a refused request changes nothing: unknown, legacy, building, not objects-v1, latest, manifest missing or invalid", async () => {
  const cases: Array<[string, (run: Setup) => void, string]> = [
    ["unknown release", (run) => { run.table.items.delete(`${ID}|${ITEM_META_SK}`); }, "unknown_release"],
    ["legacy release", (run) => { run.table.put({ ...release(run.table), layout: "legacy" }); }, "legacy_release_protected"],
    ["a release still building", (run) => { run.table.put({ ...release(run.table), state: "building" }); }, "release_not_ready"],
    ["a manifest that is not objects-v1", (run) => { run.manifest.value = { server: { mods: [] } }; }, "not_objects_release"],
    ["a manifest without storage", (run) => { run.manifest.value = { storage: { layout: "legacy" } }; }, "not_objects_release"],
    ["a manifest that is missing", (run) => { run.manifest.value = null; }, "manifest_missing"],
    ["a manifest with a bad digest", (run) => { run.manifest.value = { ...MANIFEST, server: { mods: [{ file: "a.jar", sha256: "nope", bytes: 1 }] } }; }, "invalid_manifest"],
    ["the latest release of the preset", (run) => { run.catalogs.document = catalogDocument({ latest_release: "1.4", releases: ["1.3", "1.4"], built_from: {} }); }, "latest_release_protected"],
    ["a catalog that cannot be read", (run) => { run.catalogs.document = { schema_version: 1 }; }, "catalog_unreadable"],
  ];
  for (const [name, arrange, code] of cases) {
    const run = setup();
    arrange(run);
    const before = snapshot(run.table);
    const result = await retireRelease(REQUEST, run.deps);
    assert.equal(result.status, "refused", name);
    assert.equal(result.error, code, name);
    assert.deepEqual(run.transitions, [], name);
    assert.equal(snapshot(run.table), before, name);
    assert.equal(run.catalogs.writes, 0, name);
  }
});

test("a wrong or missing confirmation is refused by the Lambda too, before it reads anything", async () => {
  for (const confirmation of [
    "minecraft/prominence@1.5", "minecraft/prominence", "prominence@1.4", " minecraft/prominence@1.4", "minecraft/prominence@1.4 ",
    "MINECRAFT/PROMINENCE@1.4", "minecraft/prominence/1.4", "", "yes",
  ]) {
    const run = setup();
    const before = snapshot(run.table);
    let read = false;
    const result = await retireRelease({ ...REQUEST, confirmation }, { ...run.deps, readManifest: async () => { read = true; return MANIFEST; } });
    assert.equal(result.status, "refused");
    assert.equal(result.error, "invalid_retire_confirmation");
    assert.equal(read, false);
    assert.equal(snapshot(run.table), before);
  }
  const run = setup();
  assert.equal((await retireRelease({ ...REQUEST, confirmation: undefined }, run.deps)).error, "invalid_request");
  assert.equal((await retireRelease(null, run.deps)).error, "invalid_request");
  assert.equal((await retireRelease(REQUEST, { ...run.deps, table: { ...run.deps.table, readRelease: async () => null } })).error, "unknown_release");
});

const worldWithGeneration = (generation: WorldRecord["currentGeneration"], closed = false): WorldRecord => (
  closed
    ? { ...RECORD, previousGenerations: [{ ...generation, closedAt: "2026-09-01T00:00:00.000Z" }] }
    : { ...RECORD, currentGeneration: generation }
);
const pointer = (extra: Partial<ReleaseState>): MarkInput => markInput({ pointers: [{ worldId: "world", state: { ...POINTER, ...extra } }] });
const archive = (versions: Array<[string, string, string]>): MarkInput => markInput({
  archives: versions.map(([versionId, release, source]) => ({
    worldId: "world", key: ARCHIVE, versionId, metadata: { release, releaseSource: source, storedAt: "2026-11-01T00:00:00.000Z" },
  })),
});

const IN_USE: Array<[string, MarkInput, string]> = [
  ["a world record's current generation", markInput({ worlds: [worldWithGeneration({ ...RECORD.currentGeneration, release: "1.4" })] }), `hold#gen#world/${GEN}`],
  ["a world record's closed generation", markInput({ worlds: [worldWithGeneration({ id: OLD_GEN, release: "1.4", createdAt: OLD, source: { kind: "preset" } }, true)] }), `hold#gen#world/${OLD_GEN}`],
  ["a pointer's desired release", pointer({ desiredRelease: "1.4" }), `hold#gen#world/${GEN}`],
  ["a pointer's active release", pointer({ activeRelease: "1.4" }), `hold#gen#world/${GEN}`],
  ["a pointer's releases run", pointer({ releasesRun: [{ release: "1.4", since: "2026-09-01T00:00:00.000Z" }] }), `hold#gen#world/${GEN}`],
  ["a pointer's pre-promotion backup", pointer({ prePromotionBackup: { key: ARCHIVE, operationId: "op", release: "1.4", recordedAt: OLD } }), `hold#gen#world/${GEN}`],
  ["the pointer from before generations", markInput({ pointers: [
    { worldId: "world", state: POINTER }, { worldId: "world", state: { ...POINTER, generationId: "legacy", desiredRelease: "1.4", activeRelease: null } },
  ] }), "hold#gen#world/legacy"],
  ["the current version of an archive", archive([["v2", "1.4", "active"]]), `hold#backup#${ARCHIVE}#v2`],
  ["a noncurrent version of an archive", archive([["v2", "1.5", "active"], ["v1", "1.4", "active"]]), `hold#backup#${ARCHIVE}#v1`],
];

for (const [name, input, holder] of IN_USE) {
  test(`the live check blocks a release that ${name} names, and puts it back to live untouched`, async () => {
    const run = setup({}, input);
    const before = snapshot(run.table);
    const result = await retireRelease(REQUEST, run.deps);
    assert.equal(result.status, "aborted");
    assert.equal(result.error, "release_in_use");
    assert.ok(result.examples?.includes(holder), `${holder} in ${JSON.stringify(result.examples)}`);
    assert.deepEqual(run.transitions, ["live->retiring", "retiring->live"]);
    assert.equal(release(run.table).state, "live");
    assert.equal(result.referencesRemoved, 0);
    assert.equal(result.holdersRemoved, 0);
    for (const sha of DIGESTS) assert.ok(backReferences(run.table, sha).includes(ID));
    assert.equal(holderItems(run.table).length, 3);
    // Only the state attribute set differs: the audit stamps of the failed attempt are removed again.
    assert.equal(snapshot(run.table), before);
    assert.equal(run.catalogs.writes, 0);
  });
}

test("the live check names at most 20 examples", async () => {
  const worlds = Array.from({ length: 30 }, (_, index): WorldRecord => ({
    ...RECORD, worldId: `world-${index}`, currentGeneration: { ...RECORD.currentGeneration, id: `gen-${index.toString(16).padStart(32, "0")}`, release: "1.4" },
  }));
  const run = setup({}, markInput({ worlds, pointers: [], archives: [] }));
  const result = await retireRelease(REQUEST, run.deps);
  assert.equal(result.error, "release_in_use");
  assert.equal(result.examples?.length, 20);
});

test("an incomplete live check aborts back to live", async () => {
  for (const failure of [
    { source: "archive", subject: "k#v", reason: "AccessDenied" },
    { source: "world", subject: "worlds/w/world.json", reason: "invalid_world_record" },
    { source: "pointer", subject: "worlds/w/release.json", reason: "invalid_release_state" },
    { source: "catalogs", subject: "presets/", reason: "AccessDenied" },
  ]) {
    const run = setup({}, markInput({ failures: [failure] }));
    const before = snapshot(run.table);
    const result = await retireRelease(REQUEST, run.deps);
    assert.equal(result.status, "aborted");
    assert.equal(result.error, "incomplete_live_check");
    assert.match(result.examples![0]!, new RegExp(failure.source));
    assert.equal(release(run.table).state, "live");
    assert.equal(snapshot(run.table), before);
  }
});

test("an archive whose release cannot be resolved also stops the retirement", async () => {
  const input = markInput({ archives: [{ worldId: "gone", key: ARCHIVE, versionId: "v1", metadata: { release: null, releaseSource: null, storedAt: OLD } }] });
  const run = setup({}, input);
  assert.equal((await retireRelease(REQUEST, run.deps)).error, "incomplete_live_check");
});

test("a build holder younger than 24 hours stops the retirement; an older one is stale", async () => {
  const young = new Date(NOW.getTime() - 3_600_000).toISOString();
  const run = setup({ holders: [{ sk: "hold#build#fresh", addedAt: young }, { sk: "hold#catalog#minecraft", addedAt: OLD }] });
  const before = snapshot(run.table);
  const result = await retireRelease(REQUEST, run.deps);
  assert.equal(result.status, "aborted");
  assert.equal(result.error, "build_in_progress");
  assert.equal(release(run.table).state, "live");
  assert.equal(snapshot(run.table), before);
  assert.equal(run.catalogs.writes, 0);

  const edge = new Date(NOW.getTime() - 24 * 3_600_000 - 1000).toISOString();
  const stale = setup({ holders: [{ sk: "hold#build#stale", addedAt: edge }, { sk: "hold#catalog#minecraft", addedAt: OLD }] });
  assert.equal((await retireRelease(REQUEST, stale.deps)).status, "retired");
  assert.deepEqual(holderItems(stale.table), []);

  const unknown = setup({ holders: [{ sk: "hold#build#nodate" }, { sk: "hold#catalog#minecraft", addedAt: OLD }] });
  assert.equal((await retireRelease(REQUEST, unknown.deps)).error, "build_in_progress");
});

test("a generation or backup holder written in the last 24 hours may belong to a write in flight", async () => {
  const young = new Date(NOW.getTime() - 60_000).toISOString();
  const run = setup({ holders: [{ sk: `hold#gen#world/${GEN}`, addedAt: young }, { sk: "hold#catalog#minecraft", addedAt: OLD }] });
  const result = await retireRelease(REQUEST, run.deps);
  assert.equal(result.error, "holder_recent");
  assert.equal(release(run.table).state, "live");
});

test("a holder that appears before the release is retired aborts back to live", async () => {
  const run = setup();
  // After the holders are listed and before the condition `holders = 0`: the catalog write sits between them.
  run.catalogs.beforeWrite = () => {
    run.table.put({ ...release(run.table), holders: Number(release(run.table).holders) + 1 });
    run.table.put({ pk: ID, sk: "hold#gen#late/gen", roles: new Set(["origin"]), added_at: OLD });
  };
  const result = await retireRelease(REQUEST, run.deps);
  assert.equal(result.status, "aborted");
  assert.equal(result.error, "holder_appeared");
  assert.deepEqual(run.transitions, ["live->retiring", "retiring->retired", "retiring->live"]);
  assert.equal(release(run.table).state, "live");
  assert.equal(release(run.table).holders, 1);
  for (const sha of DIGESTS) assert.ok(backReferences(run.table, sha).includes(ID), "no reference was removed");
});

test("the catalog write retries a lost race, and gives up after a few with the release live again", async () => {
  const retried = setup();
  retried.catalogs.lose = 2;
  const result = await retireRelease(REQUEST, retried.deps);
  assert.equal(result.status, "retired");
  assert.deepEqual(catalogPresets(retried.catalogs.document).releases, ["1.3", "1.5"]);

  const stuck = setup();
  stuck.catalogs.lose = 99;
  const before = snapshot(stuck.table);
  const aborted = await retireRelease(REQUEST, stuck.deps);
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.error, "catalog_changed");
  assert.equal(release(stuck.table).state, "live");
  // Nothing was dropped yet: the holders, the references and the catalog entry are all still there.
  assert.equal(snapshot(stuck.table), before);
  assert.ok(catalogPresets(stuck.catalogs.document).releases.includes("1.4"));
});

test("a release the catalog no longer lists needs no catalog write", async () => {
  const run = setup();
  run.catalogs.document = catalogDocument({ releases: ["1.3", "1.5"], built_from: {} });
  const result = await retireRelease(REQUEST, run.deps);
  assert.equal(result.status, "retired");
  assert.equal(result.catalogChanged, false);
  assert.equal(run.catalogs.writes, 0);
});

test("the catalog never lists a retired release: no write, no catalog entry for it", async () => {
  const run = setup();
  await retireRelease(REQUEST, run.deps);
  const listed = catalogPresets(run.catalogs.document);
  assert.ok(!listed.releases.includes("1.4"));
  assert.ok(!("1.4" in listed.built_from));
  // The result is still a catalog the control plane parses: the latest release is listed.
  assert.ok(listed.releases.includes("1.5"));
});

test("catalogWithoutRelease leaves the other presets and fields alone and does not change its input", () => {
  const document = catalogDocument();
  const copy = structuredClone(document);
  const next = catalogWithoutRelease(document, "prominence", "1.4") as typeof document;
  assert.deepEqual(document, copy);
  assert.deepEqual(next.presets[0]!.releases, ["1.3", "1.5"]);
  assert.equal(next.presets[0]!.latest_release, "1.5");
  assert.equal(catalogWithoutRelease(document, "prominence", "9.9"), null);
  assert.equal(catalogWithoutRelease(document, "other", "1.4"), null);
});

test("readers refuse the release while it is retiring and after it is retired", async () => {
  const run = setup();
  const state = async (_g: string, _p: string, release_: string) => (run.table.get(releaseItemPk(REF.gameId, REF.presetId, release_), ITEM_META_SK)?.state ?? null) as never;
  assert.equal(await checkReleaseUsable(state, REF.gameId, REF.presetId, "1.4"), "usable");
  const seen: string[] = [];
  let holdError: unknown;
  run.source.onRead = () => {
    // The live check runs while the release is `retiring`.
    void checkReleaseUsable(state, REF.gameId, REF.presetId, "1.4").then((usability) => seen.push(usability));
    new ReleaseRefs(run.table as never, "refs").hold(REF, "gen#world/new", ["desired"]).catch((error: unknown) => { holdError = error; });
  };
  await retireRelease(REQUEST, run.deps);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(seen, ["release_retired"]);
  assert.equal((holdError as Error).message, "release_retired");
  assert.equal(await checkReleaseUsable(state, REF.gameId, REF.presetId, "1.4"), "release_retired");
  assert.equal(await checkReleaseUsable(state, REF.gameId, REF.presetId, "1.5"), "usable");
});

test("a failure in the middle of the holder removal leaves the release retiring and the next request resumes it", async () => {
  const run = setup();
  let drops = 0;
  run.table.beforeSend = (command) => {
    const items = (command as { input?: { TransactItems?: Array<{ Delete?: { Key: { sk: string } } }> } }).input?.TransactItems;
    if (items?.[0]?.Delete?.Key.sk.startsWith("hold#")) {
      drops += 1;
      if (drops === 2) throw new Error("boom");
    }
  };
  await assert.rejects(retireRelease(REQUEST, run.deps), /boom/);
  assert.equal(release(run.table).state, "retiring");
  assert.equal(await checkReleaseUsable(async () => "retiring", REF.gameId, REF.presetId, "1.4"), "release_retired");
  assert.equal(holderItems(run.table).length, 2);

  run.table.beforeSend = undefined;
  const result = await retireRelease(REQUEST, run.deps);
  assert.equal(result.status, "retired");
  assert.equal(release(run.table).holders, 0);
  assert.deepEqual(holderItems(run.table), []);
  for (const sha of OWN) assert.equal(run.table.get(fileItemPk(sha), ITEM_META_SK)!.state, "condemned");
});

test("a crash in the middle of the reference removal resumes cleanly and decrements each counter once", async () => {
  const run = setup();
  let removals = 0;
  run.table.beforeSend = (command) => {
    const items = (command as { input?: { TransactItems?: Array<{ Delete?: { Key: { pk: string } } }> } }).input?.TransactItems;
    if (items?.[0]?.Delete?.Key.pk.startsWith("file#")) {
      removals += 1;
      if (removals === 3) throw new Error("boom");
    }
  };
  await assert.rejects(retireRelease(REQUEST, run.deps), /boom/);
  const doneBefore = DIGESTS.filter((sha) => !backReferences(run.table, sha).includes(ID)).length;
  assert.ok(doneBefore >= 1 && doneBefore < 6, `some removals happened (${doneBefore})`);
  // Retired already: the holders are gone and the state moved before any reference went.
  assert.equal(release(run.table).state, "retired");

  run.table.beforeSend = undefined;
  const second = await retireRelease(REQUEST, run.deps);
  assert.equal(second.status, "retired");
  assert.equal(second.alreadyRetired, true);
  assert.equal(second.referencesRemoved, 6 - doneBefore);
  for (const sha of SHARED) {
    assert.equal(run.table.get(fileItemPk(sha), ITEM_META_SK)!.refs, 1, "a shared file loses one reference, not two");
    assert.equal(run.table.get(fileItemPk(sha), ITEM_META_SK)!.state, "live");
  }
  for (const sha of OWN) {
    assert.equal(run.table.get(fileItemPk(sha), ITEM_META_SK)!.refs, 0);
    assert.equal(run.table.get(fileItemPk(sha), ITEM_META_SK)!.state, "condemned");
  }
});

test("a crash between a removal and its condemnation is repaired by the next run", async () => {
  const run = setup();
  let condemns = 0;
  run.table.beforeSend = (command) => {
    const values = (command as { input?: { ExpressionAttributeValues?: Record<string, unknown> } }).input?.ExpressionAttributeValues;
    if (values?.[":condemned"] === "condemned") {
      condemns += 1;
      if (condemns === 1) throw new Error("boom");
    }
  };
  await assert.rejects(retireRelease(REQUEST, run.deps), /boom/);
  run.table.beforeSend = undefined;
  const second = await retireRelease(REQUEST, run.deps);
  assert.equal(second.status, "retired");
  for (const sha of OWN) assert.equal(run.table.get(fileItemPk(sha), ITEM_META_SK)!.state, "condemned");
  for (const sha of SHARED) assert.equal(run.table.get(fileItemPk(sha), ITEM_META_SK)!.state, "live");
});

test("a reuse that wins against the condemnation keeps the file live", async () => {
  const run = setup();
  // A build reuses the file after it was read at refs = 0 and before the conditional update.
  run.table.beforeSend = (command) => {
    const input = (command as { input?: { Key?: { pk: string; sk: string }; ExpressionAttributeValues?: Record<string, unknown> } }).input;
    if (input?.ExpressionAttributeValues?.[":condemned"] === "condemned" && input.Key?.pk === fileItemPk(OWN[0]!)) {
      run.table.put({ ...run.table.get(fileItemPk(OWN[0]!), ITEM_META_SK)!, refs: 1 });
    }
  };
  const result = await retireRelease(REQUEST, run.deps);
  assert.equal(result.status, "retired");
  assert.equal(result.condemned, 3);
  assert.equal(run.table.get(fileItemPk(OWN[0]!), ITEM_META_SK)!.state, "live");
  assert.equal(run.table.get(fileItemPk(OWN[0]!), ITEM_META_SK)!.refs, 1);
});

test("a repeat of a finished retirement changes nothing", async () => {
  const run = setup();
  await retireRelease(REQUEST, run.deps);
  const after = snapshot(run.table);
  const catalog = JSON.stringify(run.catalogs.document);
  const again = await retireRelease(REQUEST, run.deps);
  assert.equal(again.status, "retired");
  assert.equal(again.alreadyRetired, true);
  assert.equal(again.referencesRemoved, 0);
  assert.equal(again.condemned, 0);
  assert.equal(again.holdersRemoved, 0);
  assert.equal(snapshot(run.table), after);
  assert.equal(JSON.stringify(run.catalogs.document), catalog);
});

test("a counter that is already 0 does not stop the cleanup: the reference is dropped and reported", async () => {
  const run = setup();
  run.table.put({ ...run.table.get(fileItemPk(OWN[0]!), ITEM_META_SK)!, refs: 0 });
  const result = await retireRelease(REQUEST, run.deps);
  assert.equal(result.status, "retired");
  assert.equal(result.driftRepaired, 1);
  assert.equal(result.referencesRemoved, 5);
  assert.deepEqual(backReferences(run.table, OWN[0]!), []);
});

test("the table port only gets, queries, updates and deletes: it never puts an item", async () => {
  const run = setup();
  await retireRelease(REQUEST, run.deps);
  const kinds = new Set(run.table.commands);
  for (const kind of kinds) assert.ok(["GetCommand", "QueryCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"].includes(kind), kind);
});

test("manifestDigests names each digest once", () => {
  assert.deepEqual([...manifestDigests(MANIFEST)].sort(), [...DIGESTS].sort());
  assert.deepEqual(manifestDigests({ ...MANIFEST, packs: { server: { sha256: digest(1), bytes: 1 } } }).length, 4);
});

test("inPool keeps at most the limit in flight and finishes every item", async () => {
  let active = 0;
  let peak = 0;
  const seen: number[] = [];
  await inPool(Array.from({ length: 100 }, (_, index) => index), 16, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => { setImmediate(resolve); });
    seen.push(item);
    active -= 1;
  });
  assert.equal(seen.length, 100);
  assert.ok(peak <= 16 && peak > 1, `peak ${peak}`);
  await assert.rejects(inPool([1, 2, 3], 2, async (item) => { if (item === 2) throw new Error("bad"); }), /bad/);
});

test("the Lambda logs who asked and returns a refusal instead of failing", async () => {
  const run = setup();
  const lines: string[] = [];
  const original = console.info;
  console.info = (line: unknown) => { lines.push(String(line)); };
  try {
    const refused = await retire({ ...REQUEST, confirmation: "no" }, run.deps);
    assert.equal(refused.status, "refused");
    const ok = await retire(REQUEST, run.deps);
    assert.equal(ok.status, "retired");
  } finally {
    console.info = original;
  }
  const requested = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "release_retirement_requested");
  assert.equal(requested.length, 2);
  assert.equal(requested[0]!.requestedBy, "identity:owner");
  const results = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "release_retirement_result");
  assert.deepEqual(results.map((line) => line.status), ["refused", "retired"]);
  assert.ok(lines.every((line) => !line.includes(CONFIRMATION)));
});

// --- The S3 side ---------------------------------------------------------------------

function fakeS3(handlers: { get?: () => unknown; put?: (input: Record<string, unknown>) => unknown }) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    sent,
    client: {
      async send(command: unknown) {
        const name = (command as object).constructor.name;
        const input = (command as { input: Record<string, unknown> }).input;
        sent.push({ name, input });
        if (command instanceof GetObjectCommand) return handlers.get!();
        if (command instanceof PutObjectCommand) return handlers.put!(input);
        throw new Error(`unexpected ${name}`);
      },
    } as never,
  };
}

test("the catalog store reads with the ETag and writes under If-Match, nothing else", async () => {
  const s3 = fakeS3({
    get: () => ({ ETag: "\"abc\"", Body: { transformToString: async () => JSON.stringify(catalogDocument()) } }),
    put: () => ({}),
  });
  const store = s3CatalogStore(s3.client, "bucket");
  const read = await store.read("minecraft");
  assert.equal(read?.etag, "\"abc\"");
  assert.equal(await store.write("minecraft", read!.document, read!.etag), "written");
  assert.deepEqual(s3.sent.map((call) => call.name), ["GetObjectCommand", "PutObjectCommand"]);
  assert.equal(s3.sent[1]!.input.Key, "presets/minecraft/catalog.json");
  assert.equal(s3.sent[1]!.input.IfMatch, "\"abc\"");
});

test("a lost If-Match race is `lost`, a missing catalog is null, any other error is raised", async () => {
  const lost = fakeS3({ put: () => { throw Object.assign(new Error("x"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }); } });
  assert.equal(await s3CatalogStore(lost.client, "bucket").write("minecraft", {}, "\"a\""), "lost");
  const conflict = fakeS3({ put: () => { throw Object.assign(new Error("x"), { name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } }); } });
  assert.equal(await s3CatalogStore(conflict.client, "bucket").write("minecraft", {}, "\"a\""), "lost");
  const denied = fakeS3({ put: () => { throw Object.assign(new Error("x"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); } });
  await assert.rejects(s3CatalogStore(denied.client, "bucket").write("minecraft", {}, "\"a\""), /x/);
  const none = fakeS3({ get: () => { throw Object.assign(new Error("x"), { name: "NoSuchKey" }); } });
  assert.equal(await s3CatalogStore(none.client, "bucket").read("minecraft"), null);
});

test("the live check reads worlds, the pre-generation pointer, catalogs and archives, and never lists objects/ or releases/", async () => {
  const listed: string[] = [];
  const docs = new Map<string, string>([
    ["worlds/world/world.json", JSON.stringify(worldRecordDocument(RECORD))],
    ["worlds/world/release.json", JSON.stringify({ schema_version: 1, world: "world", desired_release: "1.4", active_release: null })],
    ["presets/minecraft/catalog.json", JSON.stringify(catalogDocument())],
  ]);
  const release: ReleaseBucketReader = {
    async listKeys(prefix) { listed.push(prefix); return [...docs.keys()].filter((key) => key.startsWith(prefix)); },
    async listObjects(prefix) { listed.push(prefix); return [...docs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, size: 1 })); },
    async getText(key) { return docs.get(key) ?? null; },
  };
  const backup: BackupBucketReader = { async listVersions() { return []; }, async head() { return null; } };
  const input = await liveSourceReader({ release, backup }, () => NOW)();
  assert.deepEqual(input.failures, []);
  assert.equal(input.worlds.length, 1);
  assert.ok(input.pointers.some((entry) => entry.state.generationId === "legacy" && entry.state.desiredRelease === "1.4"), "the pre-generation pointer is read");
  assert.equal(input.catalogs.length, 1);
  assert.deepEqual(input.manifests, []);
  for (const prefix of listed) assert.ok(prefix.startsWith("worlds/") || prefix.startsWith("presets/"), `listed ${prefix}`);
  // The retirement then refuses on the legacy pointer.
  const run = setup();
  const result = await retireRelease(REQUEST, { ...run.deps, readSources: liveSourceReader({ release, backup }, () => NOW) });
  assert.equal(result.error, "release_in_use");
  assert.ok(result.examples?.includes("hold#gen#world/legacy"));
});
