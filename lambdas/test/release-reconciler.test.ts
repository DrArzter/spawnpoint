import assert from "node:assert/strict";
import test from "node:test";

import type { PresetObservation } from "../src/control-plane/preset-catalog.ts";
import { objectKey } from "../src/control-plane/release-objects.ts";
import {
  compare, mark, tableView, EXAMPLE_LIMIT, LEGACY_GENERATION, type ArchiveSource, type MarkInput, type ManifestSource, type TableItem,
} from "../src/control-plane/release-reconciler.ts";
import type { ReleaseState } from "../src/control-plane/release-state.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";

const OPEN = `gen-${"a".repeat(32)}`;
const CLOSED = `gen-${"b".repeat(32)}`;
const NOW = "2026-11-22T05:00:00.000Z";
const R10 = "minecraft/preset/1.0";
const R11 = "minecraft/preset/1.1";
const R12 = "minecraft/preset/1.2";

function digest(n: number): string {
  return n.toString(16).padStart(64, "0");
}

// Digests 1..6: a server mod, an override, the client pack, a client mod, the server pack, the full pack.
function objectsManifest(offset = 0): unknown {
  return {
    storage: { layout: "objects-v1" },
    server: {
      mods: [{ file: "a.jar", sha256: digest(offset + 1), bytes: 1 }],
      overrides: [{ path: "config/x.toml", sha256: digest(offset + 2), bytes: 1 }],
    },
    client: { kind: "mod-set", sha256: digest(offset + 3), bytes: 1, mods: [{ file: "c.jar", sha256: digest(offset + 4), bytes: 1 }] },
    packs: { server: { sha256: digest(offset + 5), bytes: 1 }, full: { sha256: digest(offset + 6), bytes: 1 } },
  };
}

const legacyManifest = { server: { mods: [{ file: "a.jar", sha256: digest(1), bytes: 1 }] } };

function manifest(release: string, value: unknown): ManifestSource {
  const [gameId, presetId, version] = release.split("/") as [string, string, string];
  return { ref: { gameId, presetId, release: version }, manifest: value };
}

function world(): WorldRecord {
  return {
    worldId: "world", gameId: "minecraft", displayName: "World", status: "active", placement: "configured", connectivity: "zerotier",
    preset: { id: "preset", repository: "https://github.com/example/presets", commit: "0".repeat(40), profileDigest: "1".repeat(64) },
    currentGeneration: { id: OPEN, release: "1.0", createdAt: "2026-08-01T00:00:00.000Z", source: { kind: "preset" } },
    previousGenerations: [{ id: CLOSED, release: "1.0", createdAt: "2026-07-01T00:00:00.000Z", source: { kind: "preset" }, closedAt: "2026-07-31T00:00:00.000Z" }],
  };
}

const ARCHIVE = `worlds/world/archives/world-${OPEN}-20261101T000000Z-${"c".repeat(64)}.tar.zst`;

function pointer(): ReleaseState {
  return {
    worldId: "world", generationId: OPEN, desiredRelease: "1.2", activeRelease: "1.1", updatedAt: NOW, updatedBy: "op-1", source: "promote-commit",
    releasesRun: [{ release: "1.0", since: "2026-08-01T00:00:00.000Z" }, { release: "1.1", since: "2026-10-01T00:00:00.000Z" }],
    prePromotionBackup: { key: ARCHIVE, operationId: "op-1", release: "1.0", recordedAt: NOW },
  };
}

function catalog(releases: readonly string[]) {
  return { gameId: "minecraft", presets: [{ id: "preset", releases } as unknown as PresetObservation] };
}

function input(overrides: Partial<MarkInput> = {}): MarkInput {
  return {
    manifestsListed: true, manifests: [], worlds: [], pointers: [], archives: [], catalogs: [], retired: new Set(), failures: [], ...overrides,
  };
}

test("mark rebuilds holders from world records, pointers, archives and the catalog, with the table's names", () => {
  const archive: ArchiveSource = {
    worldId: "world", key: ARCHIVE, versionId: "v1",
    metadata: { release: "1.1", releaseSource: "active", storedAt: "2026-11-01T00:00:00.000Z" },
  };
  const marks = mark(input({
    worlds: [world()], pointers: [{ worldId: "world", state: pointer() }], archives: [archive], catalogs: [catalog(["1.0", "1.1"])],
  }));
  const holders = marks.holders.map((holder) => `${holder.release} ${holder.sk}`).sort();
  assert.deepEqual(holders, [
    `${R10} hold#catalog#minecraft`,
    `${R10} hold#gen#world/${OPEN}`,
    `${R10} hold#gen#world/${CLOSED}`,
    `${R11} hold#backup#${ARCHIVE}#v1`,
    `${R11} hold#catalog#minecraft`,
    `${R11} hold#gen#world/${OPEN}`,
    `${R12} hold#gen#world/${OPEN}`,
  ]);
  assert.deepEqual([...marks.namedReleases].sort(), [R10, R11, R12]);
  assert.deepEqual(marks.failures, []);
});

test("mark names the digests of an objects-v1 manifest and skips a legacy or a retired one", () => {
  const marks = mark(input({
    manifests: [manifest(R10, legacyManifest), manifest(R11, objectsManifest()), manifest(R12, objectsManifest(10))],
    retired: new Set([R12]),
  }));
  assert.deepEqual([...marks.liveReleases].sort(), [R10, R11]);
  assert.deepEqual([...marks.digests.keys()], [R11], "legacy names no digest, retired is history");
  const own = marks.digests.get(R11)!;
  assert.deepEqual([...own.keys()], [1, 2, 4, 3, 5, 6].map(digest), "server mods, overrides, client mods, then the packs");
  assert.equal(own.get(digest(1)), "mods/a.jar");
  assert.equal(own.get(digest(2)), "overrides/config/x.toml");
  assert.equal(own.get(digest(4)), "client-mods/c.jar");
  assert.equal(own.get(digest(3)), "pack#client");
  assert.equal(own.get(digest(5)), "pack#server");
  assert.equal(own.get(digest(6)), "pack#full");
});

test("a digest that is not a SHA-256, or an archive no release can be found for, is a source failure", () => {
  const bad = objectsManifest() as { server: { mods: Array<{ sha256: string }> } };
  bad.server.mods[0]!.sha256 = "not-a-digest";
  const marks = mark(input({
    manifests: [manifest(R11, bad)],
    archives: [{ worldId: "gone", key: "worlds/gone/archives/x.tar.zst", versionId: "v9", metadata: { release: null, releaseSource: null, storedAt: NOW } }],
  }));
  assert.deepEqual(marks.failures.map((failure) => `${failure.source} ${failure.reason}`), ["manifest invalid_digest:mods/a.jar", "archive release_unresolved"]);
  assert.equal(marks.manifestsKnown, false);
});

test("an archive whose metadata names no release resolves through its wipe's pointer", () => {
  const marks = mark(input({
    worlds: [world()], pointers: [{ worldId: "world", state: pointer() }],
    archives: [{ worldId: "world", key: ARCHIVE, versionId: "v1", metadata: { release: null, releaseSource: null, storedAt: "2026-11-01T00:00:00.000Z" } }],
  }));
  assert.ok(marks.holders.some((holder) => holder.release === R11 && holder.sk === `hold#backup#${ARCHIVE}#v1`), "the run at that time was 1.1");
});

// A consistent world: R11 is objects-v1, held by the catalog, referenced and present.
function consistentTable(): TableItem[] {
  return [
    { pk: `release#${R11}`, sk: "meta", state: "live", layout: "objects" },
    { pk: `release#${R11}`, sk: "hold#catalog#minecraft", role: "origin" },
    ...[1, 2, 3, 4, 5, 6].flatMap((n) => [
      { pk: `file#${digest(n)}`, sk: "meta", refs: 1, state: "live" },
      { pk: `file#${digest(n)}`, sk: `release#${R11}`, path: "x" },
    ]),
  ];
}

function consistentListing(): string[] {
  return [1, 2, 3, 4, 5, 6].map((n) => objectKey(digest(n)));
}

function consistentMarks() {
  return mark(input({ manifests: [manifest(R11, objectsManifest())], catalogs: [{ gameId: "minecraft", presets: [{ id: "preset", releases: ["1.1"] } as unknown as PresetObservation] }] }));
}

function run(items: TableItem[] = consistentTable(), keys: string[] = consistentListing(), marks = consistentMarks()) {
  return compare(marks, tableView(items), { keys }, NOW, NOW);
}

function counts(report: ReturnType<typeof run>): Record<string, number> {
  return Object.fromEntries(Object.entries(report.classes).filter(([, value]) => value.count > 0).map(([name, value]) => [name, value.count]));
}

test("a consistent table, listing and marks report nothing, complete, and sweepable", () => {
  const report = run();
  assert.deepEqual(counts(report), {});
  assert.equal(report.dangerous, 0);
  assert.equal(report.complete, true);
  assert.equal(report.sweepable, true);
  assert.equal(report.startedAt, NOW);
  assert.equal(report.table_empty, false);
  assert.equal(report.generatedAt, NOW);
  assert.deepEqual(report.skipped, []);
});

test("missing_holder: a source names a release that has a table item but no matching holder", () => {
  const report = run(consistentTable().filter((item) => item.sk !== "hold#catalog#minecraft"));
  assert.deepEqual(report.classes.missing_holder.examples, [`release#${R11} / hold#catalog#minecraft`]);
  assert.equal(report.dangerous, 1);
});

test("missing_reference: a manifest names a digest the table has no back-reference to the release for", () => {
  const report = run(consistentTable().filter((item) => !(item.pk === `file#${digest(1)}` && item.sk === `release#${R11}`)));
  assert.deepEqual(report.classes.missing_reference.examples, [`release#${R11} -> file#${digest(1)}`]);
  assert.equal(report.classes.counter_drift.count, 1, "refs still says 1");
  assert.equal(report.dangerous, 1);
});

test("missing_object: a digest a live objects-v1 manifest names is absent from the listing, and is dangerous", () => {
  const report = run(consistentTable(), consistentListing().slice(1));
  assert.deepEqual(report.classes.missing_object.examples, [`release#${R11} -> file#${digest(1)}`]);
  assert.equal(report.dangerous, 1);
});

test("extra_reference: a back-reference no manifest justifies, but not one of a building release", () => {
  const extra = [
    { pk: `release#${R12}`, sk: "meta", state: "live", layout: "objects" },
    { pk: `file#${digest(9)}`, sk: "meta", refs: 1, state: "live" },
    { pk: `file#${digest(9)}`, sk: `release#${R12}`, path: "x" },
  ];
  assert.deepEqual(run([...consistentTable(), ...extra]).classes.extra_reference.examples, [`file#${digest(9)} <- release#${R12}`]);

  const building = extra.map((item) => item.sk === "meta" && item.pk.startsWith("release#") ? { ...item, state: "building" } : item);
  assert.equal(run([...consistentTable(), ...building], [...consistentListing(), objectKey(digest(9))]).classes.extra_reference.count, 0);
  assert.equal(run([...consistentTable(), ...building], [...consistentListing(), objectKey(digest(9))]).classes.orphan_object.count, 0, "its objects exist before its manifest");
  assert.equal(run().classes.extra_reference.count, 0);
});

test("a back-reference of a retired release is extra although the release item still exists", () => {
  const items = [
    ...consistentTable().map((item) => item.pk === `file#${digest(1)}` && item.sk === "meta" ? { ...item, refs: 2 } : item),
    { pk: `release#${R12}`, sk: "meta", state: "retired", layout: "objects" },
    { pk: `file#${digest(1)}`, sk: `release#${R12}`, path: "x" },
  ];
  const retired = mark(input({ manifests: [manifest(R11, objectsManifest()), manifest(R12, objectsManifest())], retired: new Set([R12]), catalogs: [{ gameId: "minecraft", presets: [{ id: "preset", releases: ["1.1"] } as unknown as PresetObservation] }] }));
  const report = run(items, consistentListing(), retired);
  assert.deepEqual(report.classes.extra_reference.examples, [`file#${digest(1)} <- release#${R12}`]);
  assert.equal(report.classes.counter_drift.count, 0);
});

test("counter_drift: refs differs from the number of back-references, or a file has back-references and no meta", () => {
  const drift = consistentTable().map((item) => item.pk === `file#${digest(2)}` && item.sk === "meta" ? { ...item, refs: 3 } : item);
  assert.deepEqual(run(drift).classes.counter_drift.examples, [`file#${digest(2)} refs=3 back-references=1`]);
  const noMeta = consistentTable().filter((item) => !(item.pk === `file#${digest(2)}` && item.sk === "meta"));
  assert.deepEqual(run(noMeta).classes.counter_drift.examples, [`file#${digest(2)} has no meta, 1 back-references`]);
});

test("orphan_object: a listed object no live manifest names; a retired release's object is an orphan too", () => {
  const report = run(consistentTable(), [...consistentListing(), objectKey(digest(7))]);
  assert.deepEqual(report.classes.orphan_object.examples, [`file#${digest(7)}`]);
  assert.equal(report.dangerous, 0);
  assert.equal(run().classes.orphan_object.count, 0);
});

test("stuck_deleting: a file item in state deleting", () => {
  const items = [...consistentTable(), { pk: `file#${digest(8)}`, sk: "meta", refs: 0, state: "deleting" }];
  assert.deepEqual(run(items).classes.stuck_deleting.examples, [`file#${digest(8)}`]);
  assert.equal(run().classes.stuck_deleting.count, 0);
});

test("unknown_object_key: a listed key that is not an object key", () => {
  const report = run(consistentTable(), [...consistentListing(), "objects/sha256/zz/notadigest", `objects/sha256/ff/${digest(1)}`]);
  assert.equal(report.classes.unknown_object_key.count, 2, "a key under the wrong two-hex folder is unknown as well");
  assert.equal(report.dangerous, 0);
});

test("unregistered_release: a legacy release with no table item is informational, not dangerous", () => {
  const marks = mark(input({
    manifests: [manifest(R11, objectsManifest()), manifest(R10, legacyManifest)],
    worlds: [world()], pointers: [], catalogs: [{ gameId: "minecraft", presets: [{ id: "preset", releases: ["1.1"] } as unknown as PresetObservation] }],
  }));
  const report = run(consistentTable(), consistentListing(), marks);
  assert.deepEqual(report.classes.unregistered_release.examples, [`release#${R10}`]);
  assert.equal(report.classes.missing_holder.count, 0, "no table item, no holder is required");
  assert.equal(report.dangerous, 0);
});

test("an empty table skips the table classes and keeps missing_object, orphan_object and unregistered_release", () => {
  const report = run([], consistentListing().slice(1).concat(objectKey(digest(7))));
  assert.equal(report.table_empty, true);
  assert.deepEqual(counts(report), { missing_object: 1, orphan_object: 1, unregistered_release: 1 });
  assert.equal(report.dangerous, 1);
  assert.deepEqual(report.skipped.map((entry) => entry.class).sort(), ["counter_drift", "extra_reference", "missing_holder", "missing_reference", "stuck_deleting"]);
  assert.ok(report.skipped.every((entry) => entry.reason === "table_empty"));
  assert.equal(report.complete, true, "an empty table is a state, not a failed read");
});

test("a failed source marks the run incomplete and the rest is still compared", () => {
  const failing = mark(input({
    manifests: [manifest(R11, objectsManifest())], manifestsListed: true,
    failures: [{ source: "world", subject: "worlds/x/world.json", reason: "AccessDenied" }],
  }));
  const report = compare(failing, tableView(consistentTable()), { keys: consistentListing().slice(1) }, NOW, NOW);
  assert.equal(report.complete, false);
  assert.equal(report.sweepable, false);
  assert.equal(report.classes.missing_object.count, 1);
  assert.deepEqual(report.failures.map((failure) => failure.source), ["world"]);
});

test("a build holder and a building release are never reported as extra or missing", () => {
  const building = [
    { pk: `release#${R12}`, sk: "meta", state: "building", layout: "objects", holders: 1 },
    { pk: `release#${R12}`, sk: "hold#build#b1", roles: new Set(["build"]) },
    { pk: `file#${digest(9)}`, sk: "meta", refs: 1, state: "live" },
    { pk: `file#${digest(9)}`, sk: `release#${R12}`, path: "mods/x.jar" },
  ];
  const report = run([...consistentTable(), ...building], [...consistentListing(), objectKey(digest(9))]);
  assert.deepEqual(counts(report), {}, "no manifest, no source holder: still nothing to report");
  assert.equal(report.dangerous, 0);
  // The holder is not derivable from any source, so no marks entry asks for it.
  assert.ok(consistentMarks().holders.every((holder) => !holder.sk.startsWith("hold#build#")));
});

test("a legacy pointer holds its releases under hold#gen#<world>/legacy", () => {
  const legacy: ReleaseState = { worldId: "world", generationId: LEGACY_GENERATION, desiredRelease: "1.2", activeRelease: "1.1", updatedAt: NOW, updatedBy: "x", source: "migration" };
  const marks = mark(input({ worlds: [world()], pointers: [{ worldId: "world", state: legacy }] }));
  const holders = marks.holders.map((holder) => `${holder.release} ${holder.sk}`);
  assert.ok(holders.includes(`${R12} hold#gen#world/${LEGACY_GENERATION}`));
  assert.ok(holders.includes(`${R11} hold#gen#world/${LEGACY_GENERATION}`));
  assert.ok(marks.namedReleases.has(R12));
  const noActive = mark(input({ worlds: [world()], pointers: [{ worldId: "world", state: { ...legacy, activeRelease: null } }] }));
  assert.ok(!noActive.holders.some((holder) => holder.release === R11));
});

test("a manifest that cannot be listed or parsed skips extra_reference and orphan_object", () => {
  const partial = mark(input({ manifestsListed: false, manifests: [manifest(R11, objectsManifest())] }));
  const items = [...consistentTable(), { pk: `file#${digest(9)}`, sk: `release#${R11}`, path: "x" }];
  const report = compare(partial, tableView(items), { keys: [...consistentListing(), objectKey(digest(7))] }, NOW, NOW);
  assert.equal(report.classes.extra_reference.count, 0);
  assert.equal(report.classes.orphan_object.count, 0);
  assert.deepEqual(report.skipped.map((entry) => `${entry.class} ${entry.reason}`).sort(), ["extra_reference manifests_incomplete", "orphan_object manifests_incomplete"]);
});

test("an unreadable table or listing skips what needs it and the run is incomplete", () => {
  const noTable = compare(consistentMarks(), null, { keys: consistentListing().slice(1) }, NOW, NOW);
  assert.equal(noTable.complete, false);
  assert.equal(noTable.table_empty, false);
  assert.equal(noTable.classes.missing_object.count, 1);
  assert.equal(noTable.classes.unregistered_release.count, 0, "without the table nothing is unregistered");

  const noListing = compare(consistentMarks(), tableView(consistentTable()), null, NOW, NOW);
  assert.equal(noListing.complete, false);
  assert.equal(noListing.dangerous, 0);
  assert.deepEqual(noListing.skipped.map((entry) => entry.class).sort(), ["missing_object", "orphan_object"]);
});

test("a class reports its full count and at most 50 sorted examples", () => {
  const many = Array.from({ length: 60 }, (_, index) => objectKey(digest(1000 + index)));
  const report = run(consistentTable(), [...consistentListing(), ...many]);
  assert.equal(report.classes.orphan_object.count, 60);
  assert.equal(report.classes.orphan_object.examples.length, EXAMPLE_LIMIT);
  assert.deepEqual(report.classes.orphan_object.examples, [...report.classes.orphan_object.examples].sort());
});
