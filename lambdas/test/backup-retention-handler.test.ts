import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBackupRetention, archivesToRemove, protectedKeys, s3RetentionStore,
  type ArchiveObject, type RetentionStore,
} from "../src/handlers/backup-retention.ts";
import { backupInventory } from "../src/control-plane/backups.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";

const OPEN = `gen-${"a".repeat(32)}`;
const CLOSED = `gen-${"b".repeat(32)}`;
let digests = 0;

function archive(generation: string | null, storedAt: string, algorithms: string[] = ["SHA256"], archivedAt = storedAt): ArchiveObject {
  digests += 1;
  const stamp = archivedAt.replaceAll("-", "").replaceAll(":", "").slice(0, 15) + "Z";
  const name = generation === null ? `world-${stamp}` : `world-${generation}-${stamp}`;
  return {
    key: `worlds/world/archives/${name}-${digests.toString(16).padStart(64, "0")}.tar.zst`,
    sizeBytes: 1024,
    storedAt,
    checksumAlgorithms: algorithms,
  };
}

function world(source: WorldRecord["currentGeneration"]["source"] = { kind: "preset" }): WorldRecord {
  return {
    worldId: "world",
    gameId: "minecraft",
    displayName: "World",
    status: "active",
    placement: "configured",
    connectivity: "zerotier",
    preset: { id: "preset", repository: "https://example.invalid/presets.git", commit: "0".repeat(40), profileDigest: "1".repeat(64) },
    currentGeneration: { id: OPEN, release: "1.0", createdAt: "2026-08-01T00:00:00.000Z", source },
    previousGenerations: [{ id: CLOSED, release: "1.0", createdAt: "2026-07-01T00:00:00.000Z", source: { kind: "preset" }, closedAt: "2026-07-31T00:00:00.000Z" }],
  };
}

// Five days, two weeks and two months of the open generation, one extra on the
// newest day and one extra in the oldest month.
function openGeneration() {
  return {
    kept: [
      archive(OPEN, "2026-11-12T20:00:00.000Z"),
      archive(OPEN, "2026-11-11T20:00:00.000Z"),
      archive(OPEN, "2026-11-10T20:00:00.000Z"),
      archive(OPEN, "2026-11-09T20:00:00.000Z"),
      archive(OPEN, "2026-11-08T20:00:00.000Z"),
      archive(OPEN, "2026-10-28T20:00:00.000Z"),
      archive(OPEN, "2026-10-21T20:00:00.000Z"),
      archive(OPEN, "2026-09-15T20:00:00.000Z"),
      archive(OPEN, "2026-08-15T20:00:00.000Z"),
    ],
    removed: [archive(OPEN, "2026-11-12T08:00:00.000Z"), archive(OPEN, "2026-08-01T20:00:00.000Z")],
  };
}

test("5/2/2 applies within each generation, so a closed generation keeps its own archives", () => {
  const open = openGeneration();
  const closed = archive(CLOSED, "2026-07-15T20:00:00.000Z");

  const removed = archivesToRemove(world(), [...open.kept, ...open.removed, closed]);

  assert.deepEqual(removed, open.removed.map((object) => object.key).sort());
  assert.ok(!removed.includes(closed.key), "pooled across generations, the July archive would fall past the two monthly slots");
});

test("the newest verified archive of the open generation is protected, not only kept by the plan", () => {
  const newestUnverified = archive(OPEN, "2026-11-13T20:00:00.000Z", []);
  const newest = archive(OPEN, "2026-11-12T20:00:00.000Z");
  const older = archive(OPEN, "2026-11-11T20:00:00.000Z");
  const closedNewer = archive(CLOSED, "2026-11-14T20:00:00.000Z");

  const keys = protectedKeys(world(), backupInventory([older, newestUnverified, newest, closedNewer], Number.POSITIVE_INFINITY).entries);

  assert.deepEqual([...keys], [newest.key]);
});

test("the archive the next start resumes from by name is kept when a later upload outruns it", () => {
  // Archived at 20:00 and uploaded at 09:00; an older archive's retried upload landed at 21:00.
  const resume = archive(OPEN, "2026-11-12T09:00:00.000Z", ["SHA256"], "2026-11-12T20:00:00.000Z");
  const retried = archive(OPEN, "2026-11-12T21:00:00.000Z", ["SHA256"], "2026-11-12T10:00:00.000Z");

  const keys = protectedKeys(world(), backupInventory([resume, retried], Number.POSITIVE_INFINITY).entries, [resume.key, retried.key]);

  assert.deepEqual([...keys].sort(), [resume.key, retried.key].sort());
  assert.deepEqual(archivesToRemove(world(), [resume, retried]), [], "by upload time alone, one a day keeps only the retried archive");
});

test("an archive a generation was restored from is never removed", () => {
  const source = archive(CLOSED, "2026-07-15T09:00:00.000Z");
  const sameDayNewer = archive(CLOSED, "2026-07-15T20:00:00.000Z");
  const record = world({ kind: "backup", key: source.key, checksum: "c".repeat(64), generationId: CLOSED });

  assert.deepEqual(archivesToRemove(record, [source, sameDayNewer]), []);
  assert.deepEqual(archivesToRemove(world(), [source, sameDayNewer]), [source.key], "without the restore, 5/2/2 keeps one a day");
});

test("an object that cannot be verified from the listing is never removed", () => {
  const unnamed: ArchiveObject = { key: "worlds/world/archives/notes.txt", sizeBytes: 1, storedAt: "2026-01-01T00:00:00.000Z", checksumAlgorithms: ["SHA256"] };
  const noChecksum = archive(OPEN, "2026-11-12T08:00:00.000Z", []);
  const newest = archive(OPEN, "2026-11-12T20:00:00.000Z");

  assert.deepEqual(archivesToRemove(world(), [unnamed, noChecksum, newest]), []);
});

test("a world with no record is left alone, and one failed world does not stop the others", async () => {
  const open = openGeneration();
  const deleted: string[] = [];
  const store: RetentionStore = {
    listWorldIds: async () => ["orphan", "broken", "world"],
    readWorld: async (worldId) => {
      if (worldId === "broken") throw new Error("invalid_world_record");
      return worldId === "world" ? world() : null;
    },
    listArchives: async (worldId) => worldId === "world" ? [...open.kept, ...open.removed] : [archive(null, "2026-01-01T00:00:00.000Z")],
    readPrePromotionBackups: async () => [],
    deleteArchive: async (key) => { deleted.push(key); },
  };
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const results = await applyBackupRetention(store);
    assert.deepEqual(results.map((result) => [result.worldId, result.result]), [["orphan", "no_world_record"], ["broken", "failed"], ["world", "applied"]]);
  } finally {
    console.error = original;
  }
  assert.deepEqual(deleted, open.removed.map((object) => object.key).sort());
  assert.equal(errors.length, 1);
});

test("the S3 store reads every page and deletes by key on the backup bucket only", async () => {
  const sent: Array<Readonly<{ name: string; input: Record<string, unknown> }>> = [];
  const pages: Record<string, unknown> = {
    "worlds/:": { CommonPrefixes: [{ Prefix: "worlds/first/" }], IsTruncated: true, NextContinuationToken: "w2" },
    "worlds/:w2": { CommonPrefixes: [{ Prefix: "worlds/second/" }, { Prefix: "worlds/Not Valid/" }], IsTruncated: false },
    "worlds/first/archives/:": { Contents: [{ Key: "worlds/first/archives/a.tar.zst", LastModified: new Date("2026-11-01T00:00:00Z"), Size: 5, ChecksumAlgorithm: ["SHA256"] }], IsTruncated: true, NextContinuationToken: "a2" },
    "worlds/first/archives/:a2": { Contents: [{ Key: "worlds/first/archives/b.tar.zst", LastModified: new Date("2026-11-02T00:00:00Z") }], IsTruncated: false },
  };
  const s3 = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "DeleteObjectCommand") return {};
      return pages[`${String(command.input.Prefix)}:${String(command.input.ContinuationToken ?? "")}`];
    },
  };
  const store = s3RetentionStore(s3 as never, "backups", { read: async () => null });

  assert.deepEqual(await store.listWorldIds(), ["first", "second"]);
  assert.deepEqual(await store.listArchives("first"), [
    { key: "worlds/first/archives/a.tar.zst", sizeBytes: 5, storedAt: "2026-11-01T00:00:00.000Z", checksumAlgorithms: ["SHA256"] },
    { key: "worlds/first/archives/b.tar.zst", sizeBytes: 0, storedAt: "2026-11-02T00:00:00.000Z", checksumAlgorithms: [] },
  ]);
  await store.deleteArchive("worlds/first/archives/a.tar.zst");

  assert.ok(sent.every((command) => command.input.Bucket === "backups"));
  assert.deepEqual(sent.at(-1), { name: "DeleteObjectCommand", input: { Bucket: "backups", Key: "worlds/first/archives/a.tar.zst" } });
  assert.equal(sent.filter((command) => command.name === "ListObjectsV2Command").length, 4);
});

test("a pre-promotion backup is kept although a later stop the same day replaced it as the day's newest", () => {
  const open = openGeneration();
  const prePromotion = open.removed[0]!;
  const removed = archivesToRemove(world(), [...open.kept, ...open.removed], [prePromotion.key]);
  assert.equal(removed.includes(prePromotion.key), false);
  assert.deepEqual(removed, [open.removed[1]!.key]);
});

test("each wipe's pre-promotion backup is read from its own pointer, and a world whose pointer fails is not pruned", async () => {
  const open = openGeneration();
  const prePromotion = open.removed[0]!.key;
  const pointer = (generationId: string, key?: string) => JSON.stringify({
    schema_version: 2, world_id: "world", generation_id: generationId, desired_release: "1.1", active_release: "1.1",
    updated_at: "2026-11-12T08:00:00.000Z", updated_by: "op-1", source: "promote-commit",
    ...(key === undefined ? {} : { pre_promotion_backup: { key, operation_id: "op-1", release: "1.0", recorded_at: "2026-11-12T08:00:00.000Z" } }),
  });
  const asked: string[] = [];
  const s3 = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      asked.push(`${String(command.input.Bucket)}/${String(command.input.Key)}`);
      const key = String(command.input.Key);
      if (key.includes(OPEN)) return { Body: { transformToString: async () => pointer(OPEN, prePromotion) }, ETag: "\"1\"" };
      return { Body: { transformToString: async () => pointer(CLOSED) }, ETag: "\"2\"" };
    },
  };
  const store = s3RetentionStore(s3 as never, "backups", { read: async () => null }, "releases");
  assert.deepEqual(await store.readPrePromotionBackups(world()), [prePromotion]);
  assert.deepEqual(asked, [
    `releases/worlds/world/generations/${OPEN}/release.json`,
    `releases/worlds/world/generations/${CLOSED}/release.json`,
  ]);

  const deleted: string[] = [];
  const failing: RetentionStore = {
    listWorldIds: async () => ["world"],
    readWorld: async () => world(),
    listArchives: async () => [...open.kept, ...open.removed],
    readPrePromotionBackups: async () => { throw new Error("pointer_unreadable"); },
    deleteArchive: async (key) => { deleted.push(key); },
  };
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual((await applyBackupRetention(failing)).map((result) => result.result), ["failed"]);
  } finally {
    console.error = original;
  }
  assert.deepEqual(deleted, []);
});
