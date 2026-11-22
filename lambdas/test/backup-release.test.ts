import assert from "node:assert/strict";
import test from "node:test";

import {
  backupRelease, resolveBackupRelease, withBackupReleases, type ArchiveMetadata, type BackupReleaseSources,
} from "../src/control-plane/backup-release.ts";
import type { ReleaseState } from "../src/control-plane/release-state.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";

const OPEN = `gen-${"a".repeat(32)}`;
const CLOSED = `gen-${"b".repeat(32)}`;
const record = {
  worldId: "prom", gameId: "minecraft", displayName: "Prom", status: "active", placement: "fleet", connectivity: "raw", auth: "game",
  preset: { id: "prominence", repository: "https://github.com/x/y", commit: "a".repeat(40), profileDigest: "b".repeat(64) },
  currentGeneration: { id: OPEN, release: "4.4", createdAt: "2026-11-01T00:00:00Z", source: { kind: "preset" } },
  previousGenerations: [
    { id: CLOSED, release: "1.0", createdAt: "2026-09-01T00:00:00Z", closedAt: "2026-11-01T00:00:00Z", source: { kind: "preset" } },
  ],
} as WorldRecord;
const key = (generationId: string, stamp = "20261110T120000Z") => `worlds/prom/archives/prom-${generationId}-${stamp}-${"c".repeat(64)}.tar.zst`;

function state(generationId: string, values: Partial<ReleaseState>): ReleaseState {
  return {
    worldId: "prom", generationId, desiredRelease: "4.9", activeRelease: "4.9",
    updatedAt: "2026-11-20T00:00:00Z", updatedBy: "op", source: "promote-commit", ...values,
  };
}

const archive = (values: Partial<ArchiveMetadata> = {}): ArchiveMetadata => ({ release: "4.4", releaseSource: null, storedAt: "2026-11-10T12:00:00Z", ...values });

test("an archive the host marked with the active release restores onto that release", () => {
  const ran = backupRelease(record.currentGeneration, archive({ release: "4.9", releaseSource: "active" }), state(OPEN, {}));
  assert.deepEqual(ran, { release: "4.9", source: "recorded" });
});

test("an older archive restores onto the release its wipe ran when it was taken, not the wipe's origin", () => {
  const runs = [{ release: "4.4", since: "2026-11-01T00:05:00Z" }, { release: "4.9", since: "2026-11-15T00:00:00Z" }];
  assert.deepEqual(backupRelease(record.currentGeneration, archive({ storedAt: "2026-11-10T12:00:00Z" }), state(OPEN, { releasesRun: runs })),
    { release: "4.4", source: "ran" });
  assert.deepEqual(backupRelease(record.currentGeneration, archive({ storedAt: "2026-11-16T12:00:00Z" }), state(OPEN, { releasesRun: runs })),
    { release: "4.9", source: "ran" });
  // Taken before the first recorded run: the oldest run known.
  assert.deepEqual(backupRelease(record.currentGeneration, archive({ storedAt: "2026-10-01T00:00:00Z" }), state(OPEN, { releasesRun: runs })),
    { release: "4.4", source: "ran" });
});

test("a wipe with no recorded runs falls back to its last active release, then to its origin", () => {
  assert.deepEqual(backupRelease(record.currentGeneration, archive(), state(OPEN, { activeRelease: "4.9" })), { release: "4.9", source: "ran" });
  assert.deepEqual(backupRelease(record.currentGeneration, archive(), state(OPEN, { activeRelease: null })), { release: "4.4", source: "origin" });
  assert.deepEqual(backupRelease(record.currentGeneration, archive(), null), { release: "4.4", source: "origin" });
});

test("a release written without the active marker, or malformed, is not trusted", () => {
  assert.deepEqual(backupRelease(record.currentGeneration, archive({ release: "9.9", releaseSource: "generation" }), null), { release: "4.4", source: "origin" });
  assert.deepEqual(backupRelease(record.currentGeneration, archive({ release: "latest", releaseSource: "active" }), null), { release: "4.4", source: "origin" });
});

function sources(metadata: Record<string, ArchiveMetadata | null>, states: Record<string, ReleaseState | null>, reads: string[] = []): BackupReleaseSources {
  return {
    readArchiveMetadata: async (archiveKey) => metadata[archiveKey] ?? null,
    readReleaseState: async (ref) => { reads.push(ref.generationId); return states[ref.generationId] ?? null; },
  };
}

test("resolution reads the source wipe's own pointer and refuses an unknown generation or a missing archive", async () => {
  const reads: string[] = [];
  const resolved = await resolveBackupRelease(record, key(CLOSED), sources({ [key(CLOSED)]: archive() }, { [CLOSED]: state(CLOSED, { activeRelease: "1.2" }) }, reads));
  assert.deepEqual(resolved, { release: "1.2", source: "ran" });
  assert.deepEqual(reads, [CLOSED]);
  assert.equal(await resolveBackupRelease(record, key(`gen-${"d".repeat(32)}`), sources({}, {})), "unknown_generation");
  assert.equal(await resolveBackupRelease(record, key(OPEN), sources({}, {})), "unknown_backup");
});

test("a listing names each backup's release, reads each wipe's pointer once, and hides a read failure", async () => {
  const reads: string[] = [];
  const first = key(OPEN, "20261110T120000Z");
  const second = key(OPEN, "20261111T120000Z");
  const broken = key(CLOSED);
  const base = sources({ [first]: archive({ release: "4.9", releaseSource: "active" }), [second]: archive() }, { [OPEN]: state(OPEN, {}) }, reads);
  const original = console.error;
  console.error = () => {};
  const listing = await withBackupReleases(record, [{ key: first }, { key: second }, { key: broken }], {
    readArchiveMetadata: async (archiveKey) => {
      if (archiveKey === broken) throw new Error("AccessDenied");
      return base.readArchiveMetadata(archiveKey);
    },
    readReleaseState: base.readReleaseState,
  }).finally(() => { console.error = original; });
  assert.deepEqual(listing.map((entry) => [entry.release, entry.releaseSource]), [["4.9", "recorded"], ["4.9", "ran"], [null, null]]);
  assert.equal(reads.filter((generation) => generation === OPEN).length, 1);
  assert.deepEqual((await withBackupReleases(null, [{ key: first }], base)).map((entry) => entry.release), [null]);
});
