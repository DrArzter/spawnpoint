import assert from "node:assert/strict";
import test from "node:test";

import { backupInventory, type BackupObject } from "../src/control-plane/backups.ts";

const object = (key: string, storedAt: string, algorithms: string[] = ["SHA256"]): BackupObject => ({
  key,
  storedAt,
  sizeBytes: 1024,
  checksumAlgorithms: algorithms,
});

const digest = (character: string) => character.repeat(64);

test("the newest verified backups come first, named as they were archived", () => {
  const inventory = backupInventory([
    object(`worlds/world/archives/world-20260830T101500Z-${digest("a")}.tar.zst`, "2026-08-30T10:15:00Z"),
    object(`worlds/world/archives/world-20260831T090000Z-${digest("b")}.tar.zst`, "2026-08-31T09:00:00Z"),
  ]);

  assert.deepEqual(inventory.entries.map((entry) => entry.storedAt), ["2026-08-31T09:00:00Z", "2026-08-30T10:15:00Z"]);
  assert.equal(inventory.entries[0]?.archiveName, "world-20260831T090000Z.tar.zst");
  assert.equal(inventory.entries[0]?.checksum, digest("b"));
  assert.equal(inventory.unverified, 0);
  assert.equal(inventory.truncated, false);
});

test("an object that cannot be verified from the listing is counted, never hidden", () => {
  const inventory = backupInventory([
    object(`worlds/world/archives/world-20260831T090000Z-${digest("b")}.tar.zst`, "2026-08-31T09:00:00Z"),
    // No digest in the key: something else wrote this, so nothing here can say
    // what it should contain.
    object("worlds/world/archives/handmade.tar.zst", "2026-08-31T08:00:00Z"),
    // The key is right but S3 holds no checksum, so the upload path did not
    // produce it either.
    object(`worlds/world/archives/world-20260829T090000Z-${digest("c")}.tar.zst`, "2026-08-29T09:00:00Z", []),
  ]);

  assert.equal(inventory.entries.length, 1);
  assert.equal(inventory.unverified, 2, "a shortened list with no count is how corruption stays invisible");
});

test("the cap limits what is shown and says so", () => {
  const objects = Array.from({ length: 5 }, (_value, index) =>
    object(`worlds/world/archives/world-${index}-${digest("d")}.tar.zst`, `2026-08-2${index}T09:00:00Z`));

  const inventory = backupInventory(objects, 2);
  assert.equal(inventory.entries.length, 2);
  assert.equal(inventory.truncated, true);
  assert.deepEqual(inventory.entries.map((entry) => entry.storedAt), ["2026-08-24T09:00:00Z", "2026-08-23T09:00:00Z"]);

  assert.equal(backupInventory(objects, 5).truncated, false);
});
