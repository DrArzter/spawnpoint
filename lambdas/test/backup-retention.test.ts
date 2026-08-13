import assert from "node:assert/strict";
import test from "node:test";

import { planBackupRetention, type BackupObject } from "../src/domain/backup-retention.ts";

function backup(key: string, lastModified: string): BackupObject {
  return { key, lastModified };
}

test("keeps nine distinct recovery points across daily, weekly and monthly tiers", () => {
  const backups = [
    backup("d1-new", "2026-08-13T20:00:00Z"),
    backup("d1-old", "2026-08-13T10:00:00Z"),
    backup("d2", "2026-08-12T20:00:00Z"),
    backup("d3", "2026-08-11T20:00:00Z"),
    backup("d4", "2026-08-10T20:00:00Z"),
    backup("d5", "2026-08-09T20:00:00Z"),
    backup("w1-new", "2026-08-08T20:00:00Z"),
    backup("w1-old", "2026-08-05T20:00:00Z"),
    backup("w2", "2026-07-29T20:00:00Z"),
    backup("m1-new", "2026-07-19T20:00:00Z"),
    backup("m1-old", "2026-07-01T20:00:00Z"),
    backup("m2", "2026-06-15T20:00:00Z"),
    backup("expired", "2026-05-15T20:00:00Z"),
  ];

  const plan = planBackupRetention(backups);

  assert.deepEqual(
    plan.keep.map(({ key, tier }) => [key, tier]),
    [
      ["d1-new", "daily"],
      ["d2", "daily"],
      ["d3", "daily"],
      ["d4", "daily"],
      ["d5", "daily"],
      ["w1-new", "weekly"],
      ["w2", "weekly"],
      ["m1-new", "monthly"],
      ["m2", "monthly"],
    ],
  );
  assert.deepEqual(
    plan.remove.map(({ key }) => key),
    ["d1-old", "w1-old", "m1-old", "expired"],
  );
});

test("keeps every backup when fewer than the policy maximum exist", () => {
  const backups = [
    backup("new", "2026-08-13T20:00:00Z"),
    backup("old", "2026-08-12T20:00:00Z"),
  ];

  const plan = planBackupRetention(backups);

  assert.deepEqual(plan.keep.map(({ key }) => key), ["new", "old"]);
  assert.deepEqual(plan.remove, []);
});

test("rejects malformed inventory instead of making destructive guesses", () => {
  assert.throws(
    () => planBackupRetention([backup("same", "2026-08-13T20:00:00Z"), backup("same", "2026-08-12T20:00:00Z")]),
    /unique/,
  );
  assert.throws(() => planBackupRetention([backup("broken", "not-a-date")]), /invalid lastModified/);
});
