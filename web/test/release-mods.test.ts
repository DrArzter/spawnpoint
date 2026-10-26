import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { action } from "../src/core/actions.ts";
import { releaseModUnion } from "../src/core/release-mods.ts";
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
