import assert from "node:assert/strict";
import test from "node:test";

import type { Identity } from "../src/access/domain.ts";
import type { BackupDownload, BackupObject } from "../src/control-plane/backups.ts";
import { backupsFeature } from "../src/handlers/api/backups.ts";

// The backups against their ports (ADR-0065): who asked is recorded before a
// link is handed over, and only this world's archive is ever linked.

const owner: Identity = { id: "identity-1", displayName: "Owner", roleId: "owner", directGrants: [] };
const key = "worlds/world-a/archives/2026-11-24T120000Z.tar.zst";

function fakes(known = true, stored: readonly BackupObject[] = []) {
  const recorded: BackupDownload[] = [];
  const linked: string[] = [];
  const feature = backupsFeature({
    knownWorld: async () => known,
    readWorldRecord: async () => null,
    archives: {
      list: async () => stored,
      link: async (asked) => { linked.push(asked); return asked === key ? { url: "https://signed.example.test/a", sizeBytes: 42 } : null; },
      releaseSources: () => ({ readArchiveMetadata: async () => null, readReleaseState: async () => null }),
    },
    downloads: { record: async (download) => { recorded.push(download); } },
    now: () => new Date("2026-11-24T12:00:00.000Z"),
  });
  return { feature, recorded, linked };
}

const ask = (value: unknown) => JSON.stringify({ key: value });

test("a download is recorded with who asked, then linked for five minutes", async () => {
  const { feature, recorded } = fakes();
  const response = await feature.backupDownload(owner, "game-a", "world-a", ask(key));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { key, url: "https://signed.example.test/a", expiresIn: 300, sizeBytes: 42 });
  assert.deepEqual(recorded, [{ at: "2026-11-24T12:00:00.000Z", identityId: "identity-1", displayName: "Owner", gameId: "game-a", worldId: "world-a", key, sizeBytes: 42 }]);
});

test("another world's key, a malformed key or an unknown world links nothing", async () => {
  for (const [known, value, status] of [
    [true, "worlds/world-b/archives/x.tar.zst", 400],
    [true, "worlds/world-a/archives/../x.tar.zst", 400],
    [true, 7, 400],
    [false, key, 404],
  ] as const) {
    const { feature, recorded, linked } = fakes(known);
    assert.equal((await feature.backupDownload(owner, "game-a", "world-a", ask(value))).statusCode, status, String(value));
    assert.deepEqual([recorded.length, linked.length], [0, 0]);
  }
});

test("a key with no archive is an unknown backup, and nothing is recorded", async () => {
  const { feature, recorded } = fakes();
  const response = await feature.backupDownload(owner, "game-a", "world-a", ask("worlds/world-a/archives/gone.tar.zst"));
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error, "unknown_backup");
  assert.deepEqual(recorded, []);
});

test("an unknown world has no inventory", async () => {
  const { feature } = fakes(false);
  assert.equal((await feature.backups("game-a", "world-a")).statusCode, 404);
});
