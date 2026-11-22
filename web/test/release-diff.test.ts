import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import type { DiffMod, ReleaseDiff } from "../src/api/contract.ts";
import { releaseChangeRows } from "../src/core/release-diff.ts";
import { releaseDiff } from "../src/demo/store.ts";
import { formatBytes } from "../src/lib/format.ts";

const mod = (file: string, rest: Partial<DiffMod> = {}): DiffMod => ({ file, sha256: "a".repeat(64), bytes: 1, side: null, modIds: null, ...rest });
const none = { added: [], removed: [], changed: [], unchanged: 0 };

const diff: ReleaseDiff = {
  release: "1.3",
  from: "1.2",
  source: "plan",
  gameVersion: { from: "1.20.1", to: "1.20.1", changed: false },
  loader: { from: { type: "forge", version: "47.4.0" }, to: { type: "forge", version: "47.4.10" }, changed: true },
  runtimeImage: { from: null, to: null, changed: false },
  serverMods: {
    added: [mod("newmod-1.jar", { modIds: ["newmod"] })],
    removed: [mod("oldmod-1.jar", { modIds: ["oldmod"] })],
    changed: [{ from: mod("create-0.5.jar", { modIds: ["create"] }), to: mod("create-0.6.jar", { modIds: ["create"] }) }],
    unchanged: 4,
  },
  overrides: [{ root: "config", added: [], removed: [{ path: "config/gone.toml", sha256: "b".repeat(64), bytes: 2 }], changed: [], unchanged: 3 }],
  clientMods: { ...none, added: [mod("shaders-1.jar", { side: "client", modIds: ["oculus"] })] },
  clientPack: { from: { sha256: "c".repeat(64), bytes: 1_048_576 }, to: { sha256: "d".repeat(64), bytes: 2_097_152 }, changed: true },
};

test("losses lead, then changes, then additions; release-wide values lead each group", () => {
  const { rows, unchanged } = releaseChangeRows(diff);
  assert.deepEqual(rows.map((row) => [row.change, row.part, row.name]), [
    ["removed", "Server mod", "oldmod-1.jar"],
    ["removed", "Override", "config/gone.toml"],
    ["changed", "Loader", "forge 47.4.10"],
    ["changed", "Client pack", formatBytes(2_097_152)],
    ["changed", "Server mod", "create-0.6.jar"],
    ["added", "Server mod", "newmod-1.jar"],
    ["added", "Client mod", "shaders-1.jar"],
  ]);
  assert.equal(rows.find((row) => row.part === "Loader")?.detail, "was forge 47.4.0");
  assert.equal(rows.find((row) => row.name === "create-0.6.jar")?.detail, "was create-0.5.jar");
  assert.equal(rows.find((row) => row.name === "shaders-1.jar")?.detail, "oculus · addon, client");
  assert.equal(unchanged, 7);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, "row keys are unique");
});

test("unchanged values and an empty diff make no rows", () => {
  const empty: ReleaseDiff = { ...diff, loader: { ...diff.loader, changed: false }, clientPack: { ...diff.clientPack, changed: false }, serverMods: none, clientMods: none, overrides: [] };
  assert.deepEqual(releaseChangeRows(empty), { rows: [], unchanged: 0 });
});

test("the demo diffs a release from the one before it, and its first release has no plan", () => {
  const later = releaseDiff("minecraft", "industrial", "1.2", null);
  assert.equal(later?.from, "1.1");
  assert.ok((later?.serverMods.added.length ?? 0) > 0);
  assert.equal(releaseDiff("minecraft", "industrial", "1.1", null), null);
});
