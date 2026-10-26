import assert from "node:assert/strict";
import test from "node:test";

import { modSideLabels, releaseModSides } from "../src/core/release-mods.ts";

const mod = (file: string) => ({ file, sha256: file.padEnd(64, "0").slice(0, 64), bytes: 1 });
const shared = mod("create.jar");
const serverOnly = mod("spark.jar");
const playersOnly = mod("minimap.jar");

test("without a players set every mod goes to both sides", () => {
  assert.deepEqual(releaseModSides({ mods: [shared, serverOnly], clientMods: null }).map((row) => row.side), ["both", "both"]);
});

test("a players set marks each mod once with where it goes, in name order (ADR-0069)", () => {
  const rows = releaseModSides({ mods: [shared, serverOnly], clientMods: [shared, playersOnly] });
  assert.deepEqual(rows.map((row) => [row.file, row.side]), [
    ["create.jar", "both"],
    ["minimap.jar", "players"],
    ["spark.jar", "server"],
  ]);
  assert.deepEqual(rows.map((row) => modSideLabels[row.side]), ["Server and players", "Players only", "Server only"]);
});
