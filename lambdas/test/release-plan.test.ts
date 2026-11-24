import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";
import { releasePlan, storedReleasePlan } from "../src/control-plane/release-plan.ts";
import { deployedReleases } from "../src/handlers/api/releases-wiring.ts";

const { releaseDiff } = deployedReleases;

// The builder's plan-release.sh is held to the same files (server/tests/release-plan-test.sh).
const fixtures = new URL("../../server/tests/fixtures/release-plan/", import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));

const cases = [
  ["modpack", "modpack-1.3.json", "modpack-1.2.json"],
  ["legacy", "modpack-1.3.json", "legacy-1.1.json"],
  ["first", "modpack-1.3.json", null],
  ["mod-set", "mod-set-2.1.json", "mod-set-2.0.json"],
] as const;

for (const [name, next, previous] of cases) {
  test(`the API diff equals the builder plan: ${name}`, () => {
    assert.deepEqual(releasePlan(fixture(next), previous === null ? null : fixture(previous)), fixture(`plan-${name}.json`));
  });
}

test("every class is reached by name, by digest and by mod id", () => {
  const plan = releasePlan(fixture("modpack-1.3.json"), fixture("modpack-1.2.json"));
  assert.ok(plan);
  assert.equal(plan.matched_by, "mod_id");
  assert.deepEqual(plan.server_mods.removed.map((mod) => mod.file), ["oldmod-1.jar"]);
  assert.deepEqual(plan.server_mods.added.map((mod) => mod.file), ["newmod-1.jar"]);
  assert.deepEqual(plan.server_mods.changed.map((change) => [change.from.file, change.to.file]),
    [["create-0.5.jar", "create-0.6.jar"], ["jei-15.1.jar", "jei-15.1.jar"]]);
  // ae2, same and backpacks by name; renamed-a -> renamed-b by digest.
  assert.equal(plan.server_mods.unchanged, 4);
});

test("an older manifest without mod_index is diffed by file name", () => {
  const plan = releasePlan(fixture("modpack-1.3.json"), fixture("legacy-1.1.json"));
  assert.equal(plan?.matched_by, "file_name");
  assert.deepEqual(plan?.server_mods.removed.map((mod) => mod.file), ["create-0.5.jar", "oldmod-1.jar"]);
});

test("a value that is not a release manifest has no plan", () => {
  assert.equal(releasePlan({ schema_version: 2 }, null), null);
  assert.equal(releasePlan(fixture("modpack-1.3.json"), { release: "1.2" }), null);
});

test("a stored plan is trusted only for the release it is stored under", () => {
  const plan = fixture("plan-modpack.json");
  assert.ok(storedReleasePlan(plan, "1.3"));
  assert.equal(storedReleasePlan(plan, "1.4"), null);
  assert.equal(storedReleasePlan({ ...(plan as object), server_mods: null }, "1.3"), null);
});

const sources = awsControlPlaneSources as Required<Pick<typeof awsControlPlaneSources, "readReleaseManifest" | "readReleasePlan">>;
const manifests: Record<string, unknown> = { "1.1": fixture("legacy-1.1.json"), "1.2": fixture("modpack-1.2.json"), "1.3": fixture("modpack-1.3.json") };

test("the built-from pair is read from plan.json", async (t) => {
  t.mock.method(sources, "readReleasePlan", async () => fixture("plan-modpack.json"));
  const manifestReads = t.mock.method(sources, "readReleaseManifest", async () => null);
  for (const from of [undefined, "1.2"]) {
    const result = await releaseDiff("minecraft", "prominence", "1.3", from);
    assert.equal(result.statusCode, 200);
    const data = JSON.parse(result.body);
    assert.equal(data.source, "plan");
    assert.equal(data.from, "1.2");
    assert.equal(data.matchedBy, "mod_id");
    assert.deepEqual(data.serverMods.removed, [{ file: "oldmod-1.jar", sha256: "d".repeat(64), bytes: 40, side: null, modIds: ["oldmod"] }]);
    assert.deepEqual(data.overrides.map((root: { root: string }) => root.root), ["config", "defaultconfigs", "kubejs", "scripts"]);
    assert.equal(data.clientPack.changed, true);
  }
  assert.equal(manifestReads.mock.callCount(), 0);
});

test("another pair, or a release with no plan, is diffed from the two manifests", async (t) => {
  t.mock.method(sources, "readReleasePlan", async () => null);
  t.mock.method(sources, "readReleaseManifest", async (_game: string, _preset: string, version: string) => manifests[version] ?? null);
  const data = JSON.parse((await releaseDiff("minecraft", "prominence", "1.3", "1.1")).body);
  assert.equal(data.source, "manifests");
  assert.equal(data.matchedBy, "file_name");
  assert.deepEqual(data.gameVersion, { from: "1.19.2", to: "1.20.1", changed: true });
  assert.equal((await releaseDiff("minecraft", "prominence", "1.3", undefined)).statusCode, 404);
  assert.equal((await releaseDiff("minecraft", "prominence", "1.3", "0.9")).statusCode, 404);
});

test("a stored plan for another pair does not answer for this one", async (t) => {
  t.mock.method(sources, "readReleasePlan", async () => fixture("plan-modpack.json"));
  t.mock.method(sources, "readReleaseManifest", async (_game: string, _preset: string, version: string) => manifests[version] ?? null);
  const data = JSON.parse((await releaseDiff("minecraft", "prominence", "1.3", "1.1")).body);
  assert.equal(data.source, "manifests");
  assert.equal(data.from, "1.1");
});

test("diff references are validated before any read", async (t) => {
  const reads = t.mock.method(sources, "readReleasePlan", async () => null);
  for (const [game, preset, version, from] of [["../x", "p", "1.0", undefined], ["minecraft", "p", "latest", undefined], ["minecraft", "p", "1.0", "1.0"], ["minecraft", "p", "1.0", "x"]] as const) {
    assert.equal((await releaseDiff(game, preset, version, from)).statusCode, 400);
  }
  assert.equal(reads.mock.callCount(), 0);
});
