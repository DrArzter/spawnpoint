import assert from "node:assert/strict";
import test from "node:test";

import { candidateReleases, planLegacyRegistration, type RegistrationInput } from "../src/control-plane/legacy-registration.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";

const GEN1 = `gen-${"1".repeat(32)}`;
const GEN2 = `gen-${"2".repeat(32)}`;
const ref = (release: string) => ({ gameId: "minecraft", presetId: "industrial", release });
const listing = (release: string, manifest: unknown = { schema_version: 1 }) => ({ ref: ref(release), manifest });
const world: WorldRecord = {
  gameId: "minecraft", worldId: "alpha", displayName: "Alpha", status: "active", placement: "configured", connectivity: "zerotier",
  preset: { id: "industrial", repository: "https://github.com/example/config", commit: "a".repeat(40), profileDigest: "b".repeat(64) },
  currentGeneration: { id: GEN2, release: "1.2", createdAt: "2026-10-18T00:00:00Z", source: { kind: "preset" } },
  previousGenerations: [{ id: GEN1, release: "1.0", createdAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-18T00:00:00Z", source: { kind: "preset" } }] as never,
};
const state = (worldId: string, generationId: string, extra: object = {}) => ({
  worldId, generationId, desiredRelease: "1.3", activeRelease: "1.2", updatedAt: "2026-11-01T00:00:00Z", updatedBy: "x", source: "test", ...extra,
});

function input(extra: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    manifests: [listing("1.0"), listing("1.1"), listing("1.2"), listing("1.3")], known: new Map(),
    catalogs: [{ gameId: "minecraft", presets: [{ id: "industrial", releases: ["1.1", "1.2", "1.3"] }] }],
    worlds: [world], pointers: [], legacyPointers: [], unreadable: [], ...extra,
  };
}

const holder = (plan: ReturnType<typeof planLegacyRegistration>, release: string, key: string) =>
  plan.holders.find((entry) => entry.ref.release === release && entry.key === key);

test("every listed release without a table item is registered; one the table knows is not", () => {
  const plan = planLegacyRegistration(input({ known: new Map([["release#minecraft/industrial/1.1", { layout: "legacy", state: "live" }]]) }));
  assert.deepEqual(plan.register.map((entry) => entry.release), ["1.0", "1.2", "1.3"]);
  assert.equal(plan.report.length, 0);
});

test("the catalog holds every release it lists, with the catalog role", () => {
  const plan = planLegacyRegistration(input());
  for (const release of ["1.1", "1.2", "1.3"]) assert.deepEqual(holder(plan, release, "catalog#minecraft")?.roles, ["catalog"]);
  assert.equal(holder(plan, "1.0", "catalog#minecraft"), undefined);
});

test("each generation of a record holds its release as the origin", () => {
  const plan = planLegacyRegistration(input());
  assert.deepEqual(holder(plan, "1.0", `gen#alpha/${GEN1}`)?.roles, ["origin"]);
  assert.deepEqual(holder(plan, "1.2", `gen#alpha/${GEN2}`)?.roles, ["origin"]);
});

test("a pointer adds desired, active, run and pre-promotion roles to the generation's holder, merged per release", () => {
  const plan = planLegacyRegistration(input({
    pointers: [{ worldId: "alpha", state: state("alpha", GEN2, {
      releasesRun: [{ release: "1.1", since: "x" }, { release: "1.2", since: "x" }],
      prePromotionBackup: { key: "k", operationId: "o", release: "1.1", recordedAt: "x" },
    }) }],
  }));
  assert.deepEqual(holder(plan, "1.3", `gen#alpha/${GEN2}`)?.roles, ["desired"]);
  assert.deepEqual([...holder(plan, "1.2", `gen#alpha/${GEN2}`)!.roles].sort(), ["active", "origin", "run"]);
  assert.deepEqual([...holder(plan, "1.1", `gen#alpha/${GEN2}`)!.roles].sort(), ["pre-promotion", "run"]);
});

test("a pointer before generations is held as the legacy generation", () => {
  const plan = planLegacyRegistration(input({ legacyPointers: [{ worldId: "alpha", generationId: "legacy", desired: "1.3", active: null, runs: [], prePromotion: null }] }));
  assert.deepEqual(holder(plan, "1.3", "gen#alpha/legacy")?.roles, ["desired"]);
});

test("an objects-v1 release gets no registration and no holder, and is reported", () => {
  const plan = planLegacyRegistration(input({ manifests: [listing("1.1", { storage: { layout: "objects-v1" } }), listing("1.2"), listing("1.3"), listing("1.0")] }));
  assert.equal(plan.register.some((entry) => entry.release === "1.1"), false);
  assert.equal(plan.holders.some((entry) => entry.ref.release === "1.1"), false);
  assert.deepEqual(plan.report.map((line) => [line.kind, line.subject]), [["objects_layout", "minecraft/industrial/1.1"]]);
});

test("a release the table holds as objects is reported, not held", () => {
  const plan = planLegacyRegistration(input({ known: new Map([["release#minecraft/industrial/1.3", { layout: "objects", state: "live" }]]) }));
  assert.equal(plan.holders.some((entry) => entry.ref.release === "1.3"), false);
  assert.equal(plan.report[0]?.kind, "objects_layout");
});

test("a release that is retiring gets no holder", () => {
  const plan = planLegacyRegistration(input({ known: new Map([["release#minecraft/industrial/1.1", { layout: "legacy", state: "retiring" }]]) }));
  assert.equal(plan.holders.some((entry) => entry.ref.release === "1.1"), false);
  assert.equal(plan.report[0]?.kind, "not_live");
});

test("a release that something names but no manifest exists is reported and never registered", () => {
  const plan = planLegacyRegistration(input({ manifests: [listing("1.0"), listing("1.2"), listing("1.3")] }));
  assert.equal(plan.register.some((entry) => entry.release === "1.1"), false);
  assert.deepEqual(plan.report.map((line) => [line.kind, line.subject]), [["no_manifest", "minecraft/industrial/1.1"]]);
});

test("a source that could not be read, and a pointer with no world record, are reported", () => {
  const plan = planLegacyRegistration(input({
    unreadable: [{ source: "world record", subject: "worlds/beta/world.json", reason: "not a valid world record" }],
    pointers: [{ worldId: "ghost", state: state("ghost", GEN1) }],
  }));
  assert.deepEqual(plan.report.map((line) => line.kind), ["unreadable", "unreadable"]);
  assert.match(plan.report[0]!.subject, /worlds\/beta\/world\.json/);
  assert.match(plan.report[1]!.subject, /ghost/);
});

test("the plan writes no file reference: it has only release registrations and holders", () => {
  const plan = planLegacyRegistration(input());
  assert.deepEqual(Object.keys(plan).sort(), ["holders", "register", "report"]);
});

test("candidate releases cover the listing and everything that names a release", () => {
  const releases = candidateReleases({ ...input({ legacyPointers: [{ worldId: "alpha", generationId: "legacy", desired: "9.9", active: null, runs: [], prePromotion: null }] }) }).map((entry) => entry.release).sort();
  assert.deepEqual(releases, ["1.0", "1.1", "1.2", "1.3", "9.9"]);
});
