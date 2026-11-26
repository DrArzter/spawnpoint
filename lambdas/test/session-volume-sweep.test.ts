import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sweepSessionVolumes, type SessionVolumes } from "../src/control-plane/session-volume-sweep.ts";
import {
  SESSION_VOLUME_MANAGED_BY,
  SESSION_VOLUME_SESSION_TAG,
  sessionVolumeSweepAction,
  type SessionVolume,
} from "../src/domain/session-volume.ts";
import type { LifecycleRecord } from "../src/domain/lifecycle.ts";

const NOW = 1_790_000_000;
const HOUR = 3600;

function volume(overrides: Partial<SessionVolume> = {}): SessionVolume {
  return { volumeId: "vol-0123456789abcdef0", state: "available", createdAtEpochSeconds: NOW - 2 * HOUR, sessionId: "s1", worldId: "w1", ...overrides };
}

test("an available volume whose session is not live is deleted; a live or young one is kept", () => {
  assert.equal(sessionVolumeSweepAction(volume(), null, NOW), "delete", "no record at all");
  assert.equal(sessionVolumeSweepAction(volume(), { activeSessionId: null }, NOW), "delete", "the world is at rest");
  assert.equal(sessionVolumeSweepAction(volume(), { activeSessionId: "s2" }, NOW), "delete", "a later session runs");
  assert.equal(sessionVolumeSweepAction(volume(), { activeSessionId: "s1" }, NOW), "keep", "its own session runs");
  assert.equal(sessionVolumeSweepAction(volume({ createdAtEpochSeconds: NOW - 60 }), null, NOW), "keep", "a start may still be making it");
});

test("an attached orphan waits for its host to go, then is reported; an untagged one is reported", () => {
  assert.equal(sessionVolumeSweepAction(volume({ state: "in-use" }), null, NOW), "keep");
  assert.equal(sessionVolumeSweepAction(volume({ state: "in-use", createdAtEpochSeconds: NOW - 5 * HOUR }), null, NOW), "report");
  assert.equal(sessionVolumeSweepAction(volume({ state: "in-use", createdAtEpochSeconds: NOW - 5 * HOUR }), { activeSessionId: "s1" }, NOW), "keep");
  assert.equal(sessionVolumeSweepAction(volume({ sessionId: null }), null, NOW), "report");
});

function fakeVolumes(list: SessionVolume[], failing = new Set<string>()): SessionVolumes & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    list: async () => list,
    delete: async (id) => {
      if (failing.has(id)) throw Object.assign(new Error("denied"), { name: "UnauthorizedOperation" });
      deleted.push(id);
    },
  };
}

function lifecycle(records: Record<string, Partial<LifecycleRecord>>) {
  const reads: string[] = [];
  return {
    reads,
    read: async (serverId: string) => {
      reads.push(serverId);
      const record = records[serverId];
      return record ? { revision: 1, record: record as LifecycleRecord } : null;
    },
  };
}

test("the sweep reads the world's own record and deletes only orphans", async () => {
  const volumes = fakeVolumes([
    volume({ volumeId: "vol-live", sessionId: "s1", worldId: "w1" }),
    volume({ volumeId: "vol-orphan", sessionId: "s9", worldId: "w2" }),
  ]);
  const records = lifecycle({ "world#w1": { activeSessionId: "s1" }, "world#w2": { activeSessionId: null } });
  const result = await sweepSessionVolumes(volumes, records, NOW, { info: () => {} });
  assert.deepEqual(volumes.deleted, ["vol-orphan"]);
  assert.deepEqual(result, { deleted: ["vol-orphan"], survivors: [] });
  assert.deepEqual(records.reads.sort(), ["world#w1", "world#w2"]);
});

test("a volume that cannot be deleted or stays attached survives the sweep and is reported", async () => {
  const volumes = fakeVolumes([
    volume({ volumeId: "vol-denied" }),
    volume({ volumeId: "vol-stuck", state: "in-use", createdAtEpochSeconds: NOW - 5 * HOUR }),
  ], new Set(["vol-denied"]));
  const result = await sweepSessionVolumes(volumes, lifecycle({}), NOW, { info: () => {} });
  assert.deepEqual(result.deleted, []);
  assert.equal(result.survivors.length, 2);
  assert.match(result.survivors.join(";"), /vol-denied: delete failed, UnauthorizedOperation/);
  assert.match(result.survivors.join(";"), /vol-stuck: in-use/);
});

test("the tag values are the ones Terraform renders into the workflows and IAM", async () => {
  const terraform = await readFile(new URL("../../infra/terraform-operations/session-volume.tf", import.meta.url), "utf8");
  assert.match(terraform, new RegExp(`session_volume_managed_by\\s*=\\s*"${SESSION_VOLUME_MANAGED_BY}"`));
  assert.match(terraform, new RegExp(`session_volume_session_tag\\s*=\\s*"${SESSION_VOLUME_SESSION_TAG}"`));
});
