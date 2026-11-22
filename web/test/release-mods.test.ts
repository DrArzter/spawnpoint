import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { action } from "../src/core/actions.ts";
import type { ModRow } from "../src/core/models.ts";
import { modSourceCounts, modSourceLabel, releaseModUnion, sortMods } from "../src/core/release-mods.ts";
import { withReleasePacks } from "../src/core/worlds.ts";

const mod = (file: string) => ({ file, sha256: file.padEnd(64, "0").slice(0, 64), bytes: 1 });
const shared = mod("create.jar");
const serverOnly = mod("spark.jar");
const playersOnly = mod("minimap.jar");

test("one list holds every mod of a release once, in name order (ADR-0069)", () => {
  assert.deepEqual(releaseModUnion({ mods: [shared, serverOnly], clientMods: null }).map((row) => row.file), ["create.jar", "spark.jar"]);
  assert.deepEqual(releaseModUnion({ mods: [shared, serverOnly], clientMods: [shared, playersOnly] }).map((row) => row.file), ["create.jar", "minimap.jar", "spark.jar"]);
});

test("a release with side lists offers client, server and full packs; any other keeps its one download", () => {
  const requested: string[] = [];
  const client = action("world.pack", "Download", () => requested.push("client"), { icon: "download" });
  const rows = [{ name: "1.2", downloads: [client] }, { name: "1.3", downloads: [] }];

  const split = withReleasePacks(rows, "1.2", (release, pack) => requested.push(`${release} ${pack}`));
  assert.deepEqual(split[0]?.downloads.map((item) => [item.id, item.label]), [
    ["world.pack", "Client"],
    ["release.pack.server", "Server"],
    ["release.pack.full", "Full"],
  ]);
  split[0]?.downloads[1]?.run();
  split[0]?.downloads[2]?.run();
  assert.deepEqual(requested, ["1.2 server", "1.2 full"]);
  assert.deepEqual(split[1]?.downloads, []);

  assert.deepEqual(withReleasePacks(rows, null, () => undefined)[0]?.downloads.map((item) => item.label), ["Download"]);
});

const row = (file: string, bytes: number, source: ModRow["source"]): ModRow => ({ file, bytes, sha256: file.padEnd(64, "0").slice(0, 64), source, download: action(`mod.download.${file}`, "Download", () => undefined) });
const rows = [row("b.jar", 30, "modrinth"), row("a.jar", 10, null), row("d.jar", 20, "curseforge"), row("c.jar", 20, "modrinth")];

test("a mod's source is named in words, and a release without one reads as unknown", () => {
  assert.equal(modSourceLabel("github"), "GitHub");
  assert.equal(modSourceLabel(null), "Unknown");
});

test("the source filter offers the sources a release holds with their counts, unknown last, and nothing for an old release", () => {
  assert.deepEqual(modSourceCounts(rows).map((entry) => [entry.label, entry.count]), [["CurseForge", 1], ["Modrinth", 2], ["Unknown", 1]]);
  assert.deepEqual(modSourceCounts([row("a.jar", 1, null), row("b.jar", 2, null)]), []);
  assert.deepEqual(modSourceCounts([]), []);
});

test("mods sort by name, source or size, and equal rows keep name order in both directions", () => {
  const names = (key: Parameters<typeof sortMods>[1], direction: Parameters<typeof sortMods>[2]) => sortMods(rows, key, direction).map((item) => item.file);
  assert.deepEqual(names("name", "ascending"), ["a.jar", "b.jar", "c.jar", "d.jar"]);
  assert.deepEqual(names("name", "descending"), ["d.jar", "c.jar", "b.jar", "a.jar"]);
  assert.deepEqual(names("source", "ascending"), ["d.jar", "b.jar", "c.jar", "a.jar"]);
  assert.deepEqual(names("size", "ascending"), ["a.jar", "c.jar", "d.jar", "b.jar"]);
  assert.deepEqual(names("size", "descending"), ["b.jar", "c.jar", "d.jar", "a.jar"]);
  assert.deepEqual(rows.map((item) => item.file), ["b.jar", "a.jar", "d.jar", "c.jar"], "the input is not reordered");
});
