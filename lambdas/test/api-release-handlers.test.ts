import assert from "node:assert/strict";
import test from "node:test";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";
import { releaseRetirement } from "../src/control-plane/aws-release-retirement.ts";
import { createDispatcher } from "../src/handlers/api/dispatcher.ts";
import { buildRelease, releaseManifest, releasePackDownload, requestReleaseRetirement } from "../src/handlers/api/releases.ts";
import { releasesRoutes } from "../src/handlers/api/releases-routes.ts";
import { composeRoutes } from "../src/handlers/api/routing.ts";

const identity = { id: "operator", displayName: "Operator", roleId: "operator", directGrants: [] } as const;
const sources = awsControlPlaneSources as Required<Pick<typeof awsControlPlaneSources, "readReleaseManifest">>;

test("release manifests retain the client-facing metadata and exact source revision", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => ({
    release: "1.2", minecraft_version: "1.20.1", loader: { type: "fabric", version: "0.19.3" },
    source_profile: { id: "industrial", repository: "https://github.com/example/config", commit: "a".repeat(40) },
    server: { mods: [{ file: "example.jar", sha256: "b".repeat(64), bytes: 123 }] },
  }));
  const result = await releaseManifest("minecraft", "industrial", "1.2");
  assert.equal(result.statusCode, 200);
  const data = JSON.parse(result.body);
  assert.deepEqual(data.loader, { type: "fabric", version: "0.19.3" });
  assert.deepEqual(data.source, { presetId: "industrial", repository: "https://github.com/example/config", commit: "a".repeat(40) });
  assert.deepEqual(data.mods, [{ file: "example.jar", sha256: "b".repeat(64), bytes: 123 }]);
  // Players install the server's set: no separate one to show.
  assert.equal(data.clientMods, null);
});

test("a mod's source is answered when the manifest names a known one, and left out otherwise", async (t) => {
  const mod = (file: string, source?: unknown) => ({ file, sha256: file.padEnd(64, "0"), bytes: 1, ...(source === undefined ? {} : { source }) });
  t.mock.method(sources, "readReleaseManifest", async () => ({
    release: "1.5",
    server: { mods: [mod("a.jar", "curseforge"), mod("b.jar", "modrinth"), mod("c.jar", "github"), mod("d.jar", "elsewhere"), mod("e.jar")] },
    client: { kind: "mod-set", mods: [mod("a.jar", "curseforge"), mod("f.jar", "modrinth")] },
  }));
  const data = JSON.parse((await releaseManifest("minecraft", "industrial", "1.5")).body);
  assert.deepEqual(data.mods.map((item: { source?: string }) => item.source ?? null), ["curseforge", "modrinth", "github", null, null]);
  assert.equal("source" in data.mods[4], false);
  assert.deepEqual(data.clientMods.map((item: { source?: string }) => item.source ?? null), ["curseforge", "modrinth"]);
});

test("a release with side lists answers the players' set beside the server's (ADR-0069)", async (t) => {
  const shared = { file: "shared.jar", sha256: "a".repeat(64), bytes: 1 };
  t.mock.method(sources, "readReleaseManifest", async () => ({
    release: "1.3", server: { mods: [shared, { file: "spark.jar", sha256: "b".repeat(64), bytes: 2 }] },
    client: { kind: "mod-set", mods: [shared, { file: "minimap.jar", sha256: "c".repeat(64), bytes: 3 }] },
  }));
  const data = JSON.parse((await releaseManifest("minecraft", "industrial", "1.3")).body);
  assert.deepEqual(data.mods.map((mod: { file: string }) => mod.file), ["shared.jar", "spark.jar"]);
  assert.deepEqual(data.clientMods.map((mod: { file: string }) => mod.file), ["shared.jar", "minimap.jar"]);
});

test("a modpack release with addons answers each addon and its side; mod_index stays out (ADR-0077)", async (t) => {
  const backpacks = { file: "sophisticatedbackpacks-1.20.1-3.23.4.5.110.jar", sha256: "a".repeat(64), bytes: 986101 };
  t.mock.method(sources, "readReleaseManifest", async () => ({
    release: "1.4", server: { mods: [{ file: "fabric-api.jar", sha256: "b".repeat(64), bytes: 2 }, backpacks] },
    client: { kind: "curseforge-modpack", file: "client.zip", sha256: "c".repeat(64), bytes: 3, addons: [{ ...backpacks, side: "both" }] },
    mod_index: { ["a".repeat(64)]: ["sophisticatedbackpacks"] },
  }));
  const data = JSON.parse((await releaseManifest("minecraft", "prominence", "1.4")).body);
  assert.deepEqual(data.addons, [{ ...backpacks, side: "both" }]);
  assert.equal(data.clientMods, null);
  assert.equal("mod_index" in data, false);
});

test("a release without addons answers an empty list", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => ({ release: "1.0", server: { mods: [] } }));
  assert.deepEqual(JSON.parse((await releaseManifest("minecraft", "prominence", "1.0")).body).addons, []);
});

test("manifest text fields cannot stringify objects or arrays into misleading metadata", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => ({
    loader: { type: {}, version: [] }, source_profile: { id: {}, repository: [], commit: null },
    server: { mods: [{ file: {}, sha256: [], bytes: 1 }] },
  }));
  const result = await releaseManifest("minecraft", "industrial", "1.2");
  const data = JSON.parse(result.body);
  assert.deepEqual(data.loader, { type: "", version: "" });
  assert.deepEqual(data.source, { presetId: "", repository: "", commit: "" });
  assert.deepEqual(data.mods, [{ file: "", sha256: "", bytes: 1 }]);
  assert.ok(!result.body.includes("[object Object]"));
});

test("a missing manifest stays a 404 and invalid references never reach storage", async (t) => {
  const read = t.mock.method(sources, "readReleaseManifest", async () => null);
  assert.equal((await releaseManifest("minecraft", "industrial", "../1.2")).statusCode, 400);
  assert.equal(read.mock.callCount(), 0);
  const missing = await releaseManifest("minecraft", "industrial", "1.2");
  assert.deepEqual(JSON.parse(missing.body), { error: "unknown_release" });
  assert.equal(missing.statusCode, 404);
});

// --- The mod list, one page at a time ---------------------------------------------------

const listed = (file: string, bytes: number, source?: string) => ({ file, sha256: file.padEnd(64, "0").slice(0, 64), bytes, ...(source ? { source } : {}) });
const bigManifest = {
  release: "1.4",
  server: { mods: [listed("b-Create.jar", 30, "modrinth"), listed("a-jei.jar", 10), listed("d-curios.jar", 20, "curseforge"), listed("c-create-extra.jar", 20, "modrinth"), listed("e-spark.jar", 5, "github")] },
  client: { kind: "mod-set", mods: [listed("b-Create.jar", 30, "modrinth"), listed("f-minimap.jar", 7, "modrinth")] },
};

async function page(query: Record<string, string>) {
  const result = await releaseManifest("minecraft", "prominence", "1.4", query);
  return { status: result.statusCode, data: JSON.parse(result.body) };
}

const files = (data: { mods: Array<{ file: string }> }) => data.mods.map((mod) => mod.file);

test("a mod list request answers one page with totals, source counts and the players' set flag", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => bigManifest);
  const { status, data } = await page({ page: "1", pageSize: "2" });
  assert.equal(status, 200);
  assert.deepEqual(files(data), ["a-jei.jar", "b-Create.jar"]);
  assert.deepEqual([data.all, data.total, data.page, data.pageSize, data.pages, data.split], [6, 6, 1, 2, 3, true]);
  assert.deepEqual(data.sources, [{ source: "curseforge", count: 1 }, { source: "modrinth", count: 3 }, { source: "github", count: 1 }, { source: "unknown", count: 1 }]);
  assert.equal("clientMods" in data, false);
  assert.deepEqual(files((await page({ page: "3", pageSize: "2" })).data), ["e-spark.jar", "f-minimap.jar"]);
});

test("paging defaults to 50 rows and clamps a page past the end to the last", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => bigManifest);
  const first = await page({ page: "1" });
  assert.equal(first.data.pageSize, 50);
  const past = await page({ page: "99", pageSize: "4" });
  assert.deepEqual([past.status, past.data.page, past.data.pages, files(past.data)], [200, 2, 2, ["e-spark.jar", "f-minimap.jar"]]);
});

test("a large release is cut to the page size and never answered whole", async (t) => {
  const many = Array.from({ length: 367 }, (_, index) => listed(`mod-${String(index).padStart(3, "0")}.jar`, index, "curseforge"));
  t.mock.method(sources, "readReleaseManifest", async () => ({ release: "1.4", server: { mods: many } }));
  const { data } = await page({ pageSize: "200" });
  assert.deepEqual([data.mods.length, data.total, data.pages], [200, 367, 2]);
  assert.equal((await page({ pageSize: "200", page: "2" })).data.mods.length, 167);
});

test("search matches the file name without regard to case, and the filter and total follow it", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => bigManifest);
  const found = await page({ query: "  CREATE " });
  assert.deepEqual(files(found.data), ["b-Create.jar", "c-create-extra.jar"]);
  assert.equal(found.data.total, 2);
  assert.equal(found.data.all, 6, "the unfiltered count stays, so a list can tell no match from no mods");
  assert.equal(found.data.sources.length, 4, "source counts cover the release, not the search");
  const none = await page({ query: "nothing-here" });
  assert.deepEqual([none.status, none.data.total, none.data.mods, none.data.page, none.data.pages], [200, 0, [], 1, 1]);
});

test("the source filter takes a known source or unknown", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => bigManifest);
  assert.deepEqual(files((await page({ source: "modrinth" })).data), ["b-Create.jar", "c-create-extra.jar", "f-minimap.jar"]);
  assert.deepEqual(files((await page({ source: "unknown" })).data), ["a-jei.jar"]);
  assert.deepEqual(files((await page({ source: "github", query: "spark" })).data), ["e-spark.jar"]);
  assert.deepEqual(files((await page({ source: "github", query: "jei" })).data), []);
});

test("mods sort by name, source or size in either order, and equal rows keep name order", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => bigManifest);
  const order = async (sort: string, direction: string) => files((await page({ sort, order: direction })).data);
  assert.deepEqual(await order("name", "asc"), ["a-jei.jar", "b-Create.jar", "c-create-extra.jar", "d-curios.jar", "e-spark.jar", "f-minimap.jar"]);
  assert.deepEqual(await order("name", "desc"), ["f-minimap.jar", "e-spark.jar", "d-curios.jar", "c-create-extra.jar", "b-Create.jar", "a-jei.jar"]);
  assert.deepEqual(await order("source", "asc"), ["d-curios.jar", "b-Create.jar", "c-create-extra.jar", "f-minimap.jar", "e-spark.jar", "a-jei.jar"]);
  assert.deepEqual(await order("source", "desc"), ["a-jei.jar", "e-spark.jar", "b-Create.jar", "c-create-extra.jar", "f-minimap.jar", "d-curios.jar"]);
  assert.deepEqual(await order("size", "asc"), ["e-spark.jar", "f-minimap.jar", "a-jei.jar", "c-create-extra.jar", "d-curios.jar", "b-Create.jar"]);
  assert.deepEqual(await order("size", "desc"), ["b-Create.jar", "c-create-extra.jar", "d-curios.jar", "a-jei.jar", "f-minimap.jar", "e-spark.jar"]);
});

test("a release that recorded no sources offers no source counts, and its rows carry none", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => ({ release: "1.0", server: { mods: [listed("a.jar", 1), listed("b.jar", 2)] } }));
  const { data } = await page({ page: "1" });
  assert.deepEqual([data.sources, data.split, data.total], [[], false, 2]);
  assert.equal(data.mods.some((mod: object) => "source" in mod), false);
  assert.deepEqual(files((await page({ source: "unknown" })).data), ["a.jar", "b.jar"]);
});

test("invalid mod list parameters are a 400 and never reach storage", async (t) => {
  const read = t.mock.method(sources, "readReleaseManifest", async () => bigManifest);
  const invalid: Array<Record<string, string>> = [
    { page: "0" }, { page: "-1" }, { page: "1.5" }, { page: "abc" }, { page: "" }, { page: "9999999" },
    { pageSize: "0" }, { pageSize: "201" }, { pageSize: "x" },
    { sort: "date" }, { sort: "" }, { order: "up" }, { order: "ASC" },
    { source: "gitlab" }, { source: "" }, { query: "x".repeat(101) },
    { colour: "red" }, { page: "1", unknown: "1" },
  ];
  for (const query of invalid) {
    const result = await releaseManifest("minecraft", "prominence", "1.4", query);
    assert.deepEqual([result.statusCode, JSON.parse(result.body)], [400, { error: "invalid_mod_query" }], JSON.stringify(query));
  }
  assert.equal(read.mock.callCount(), 0);
  assert.equal((await page({ pageSize: "200" })).status, 200);
  assert.equal((await page({ query: "x".repeat(100) })).status, 200);
});

test("a request without parameters still answers the whole manifest for the MCP tool", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => bigManifest);
  const data = JSON.parse((await releaseManifest("minecraft", "prominence", "1.4")).body);
  assert.equal(data.mods.length, 5);
  assert.equal(data.clientMods.length, 2);
  assert.equal("total" in data, false);
});

test("a mod list request for an unknown release is a 404", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => null);
  assert.deepEqual([(await page({ page: "1" })).status, (await page({ page: "1" })).data], [404, { error: "unknown_release" }]);
});

test("the route hands its query to the handler under release.read", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => bigManifest);
  const principal = { provider: "telegram", subject: "1", displayName: "T", username: null, email: null, photoUrl: null } as const;
  const dispatch = createDispatcher(composeRoutes(releasesRoutes), {
    caller: async () => principal,
    resolveIdentity: async () => ({ id: "operator", displayName: "T", roleId: "operator", directGrants: [] }),
    panelOrigins: ["https://panel.example"],
  });
  const result = await dispatch({
    routeKey: "GET /games/{gameId}/presets/{presetId}/releases/{version}",
    pathParameters: { gameId: "minecraft", presetId: "prominence", version: "1.4" },
    queryStringParameters: { pageSize: "2", query: "create" },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(files(JSON.parse(result.body)), ["b-Create.jar", "c-create-extra.jar"]);
});

test("build input rejects malformed JSON separately from an invalid pinned-build request", async () => {
  const malformed = await buildRelease(identity, "minecraft", "industrial", "{");
  assert.deepEqual(JSON.parse(malformed.body), { error: "invalid_json" });
  for (const body of ["null", "[]", "{}", JSON.stringify({ profileDigest: "a".repeat(64), retryRelease: "../1.2" })]) {
    const result = await buildRelease(identity, "minecraft", "industrial", body);
    assert.equal(result.statusCode, 400);
    assert.deepEqual(JSON.parse(result.body), { error: "invalid_build_request" });
  }
});

test("a release pack is one of client, server or full, and nothing reaches storage otherwise", async () => {
  for (const [pack, version] of [["everything", "1.2"], ["../client", "1.2"], ["server", "latest"]] as const) {
    const result = await releasePackDownload("minecraft", "industrial", version, pack);
    assert.equal(result.statusCode, 400);
    assert.deepEqual(JSON.parse(result.body), { error: "invalid_release_reference" });
  }
});

// --- Retiring a release (ADR-0080) ---------------------------------------------------

const owner = { id: "owner", displayName: "Owner", roleId: "owner", directGrants: [] } as const;
const RETIRE_KEY = "POST /games/{gameId}/presets/{presetId}/releases/{version}/retire";
const objectsManifest = { release: "1.4", storage: { layout: "objects-v1" }, server: { mods: [] } };

function retireEvent(body: string) {
  return {
    routeKey: RETIRE_KEY, body,
    pathParameters: { gameId: "minecraft", presetId: "prominence", version: "1.4" },
  };
}

test("retiring needs the typed game/preset@release and queues one asynchronous request", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => objectsManifest);
  const request = t.mock.method(releaseRetirement, "request", async () => undefined);
  const result = await requestReleaseRetirement(owner, "minecraft", "prominence", "1.4", JSON.stringify({ confirmation: "minecraft/prominence@1.4" }));
  assert.equal(result.statusCode, 202);
  assert.deepEqual(JSON.parse(result.body), { status: "requested", release: "1.4" });
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(request.mock.calls[0]!.arguments[0], {
    gameId: "minecraft", presetId: "prominence", release: "1.4", confirmation: "minecraft/prominence@1.4", requestedBy: "identity:owner",
  });
});

test("a wrong, missing or padded confirmation is a 400 and invokes nothing", async (t) => {
  const read = t.mock.method(sources, "readReleaseManifest", async () => objectsManifest);
  const request = t.mock.method(releaseRetirement, "request", async () => undefined);
  const bodies: Array<string | undefined> = [
    undefined, "", "{}", JSON.stringify({ confirmation: "" }), JSON.stringify({ confirmation: "minecraft/prominence@1.5" }),
    JSON.stringify({ confirmation: "minecraft/prominence@1.4 " }), JSON.stringify({ confirmation: "Minecraft/prominence@1.4" }),
    JSON.stringify({ confirmation: "1.4" }), JSON.stringify({ confirmation: ["minecraft/prominence@1.4"] }),
    JSON.stringify({ confirmation: "minecraft/prominence@1.4", extra: true }),
  ];
  for (const body of bodies) {
    const result = await requestReleaseRetirement(owner, "minecraft", "prominence", "1.4", body);
    assert.equal(result.statusCode, 400, String(body));
    assert.deepEqual(JSON.parse(result.body), { error: "invalid_retire_confirmation" }, String(body));
  }
  for (const body of ["{", "[]", "null"]) {
    const result = await requestReleaseRetirement(owner, "minecraft", "prominence", "1.4", body);
    assert.deepEqual([result.statusCode, JSON.parse(result.body)], [400, { error: "invalid_json" }]);
  }
  assert.equal(request.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0, "a refused confirmation reads nothing");
});

test("a malformed reference is a 400, an unknown release a 404, and neither invokes anything", async (t) => {
  const request = t.mock.method(releaseRetirement, "request", async () => undefined);
  t.mock.method(sources, "readReleaseManifest", async () => null);
  const body = JSON.stringify({ confirmation: "minecraft/prominence@1.4" });
  assert.equal((await requestReleaseRetirement(owner, "minecraft", "prominence", "../1.4", body)).statusCode, 400);
  assert.equal((await requestReleaseRetirement(owner, "Minecraft", "prominence", "1.4", body)).statusCode, 400);
  const unknown = await requestReleaseRetirement(owner, "minecraft", "prominence", "1.4", body);
  assert.deepEqual([unknown.statusCode, JSON.parse(unknown.body)], [404, { error: "unknown_release" }]);
  assert.equal(request.mock.callCount(), 0);
});

test("a request that cannot be queued is a 503 and says nothing about the cause", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => objectsManifest);
  t.mock.method(releaseRetirement, "request", async () => { throw new Error("secret detail"); });
  t.mock.method(console, "error", () => undefined);
  const result = await requestReleaseRetirement(owner, "minecraft", "prominence", "1.4", JSON.stringify({ confirmation: "minecraft/prominence@1.4" }));
  assert.deepEqual([result.statusCode, JSON.parse(result.body)], [503, { error: "retirement_request_failed" }]);
});

test("the dispatcher refuses an Operator and every other role but the Owner before the handler runs", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => objectsManifest);
  const request = t.mock.method(releaseRetirement, "request", async () => undefined);
  const body = JSON.stringify({ confirmation: "minecraft/prominence@1.4" });
  const principal = { provider: "telegram", subject: "1", displayName: "T", username: null, email: null, photoUrl: null } as const;
  const dispatch = (roleId: string) => createDispatcher(composeRoutes(releasesRoutes), {
    caller: async () => principal,
    resolveIdentity: async () => ({ id: roleId, displayName: "T", roleId, directGrants: [] }),
    panelOrigins: ["https://panel.example"],
  });
  for (const roleId of ["viewer", "player", "operator"]) {
    const refused = await dispatch(roleId)(retireEvent(body));
    assert.equal(refused.statusCode, 403, roleId);
    assert.equal(request.mock.callCount(), 0, roleId);
  }
  const accepted = await dispatch("owner")(retireEvent(body));
  assert.equal(accepted.statusCode, 202);
  assert.equal(request.mock.callCount(), 1);
  assert.equal(request.mock.calls[0]!.arguments[0]?.requestedBy, "identity:owner");
  // A direct grant is the only other way to hold it, and that is an owner decision.
  const granted = await createDispatcher(composeRoutes(releasesRoutes), {
    caller: async () => principal,
    resolveIdentity: async () => ({ id: "ops", displayName: "T", roleId: "operator", directGrants: ["release.retire"] }),
    panelOrigins: ["https://panel.example"],
  })(retireEvent(body));
  assert.equal(granted.statusCode, 202);
});
