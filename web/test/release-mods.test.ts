import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { action } from "../src/core/actions.ts";
import { FRESH_MODS_VIEW, MOD_PAGE_SIZE, modListQuery, modSourceEntries, modSourceLabel } from "../src/core/release-mods.ts";
import { compareReleases, newestFirst } from "../src/core/release-order.ts";
import { worldsApi } from "../src/api/live/worlds.ts";
import type { ModsModel } from "../src/core/models.ts";
import { narrow, tokensOf } from "../src/skins/console/tabs/Releases.tsx";
import { withReleasePacks } from "../src/core/worlds.ts";

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

test("a mod's source is named in words, and a release without one reads as unknown", () => {
  assert.equal(modSourceLabel("github"), "GitHub");
  assert.equal(modSourceLabel(null), "Unknown");
});

test("the source filter offers the sources the server counted in list order, unknown last", () => {
  assert.deepEqual(
    modSourceEntries([{ source: "unknown", count: 1 }, { source: "github", count: 4 }, { source: "curseforge", count: 2 }]).map((entry) => [entry.source, entry.label, entry.count]),
    [["curseforge", "CurseForge", 2], ["github", "GitHub", 4], ["unknown", "Unknown", 1]],
  );
  assert.deepEqual(modSourceEntries([]), [], "an old release offers no filter");
});

test("a view becomes the query the server is asked: the applied search, one page of fifty, and the order in the API's words", () => {
  assert.deepEqual(modListQuery(FRESH_MODS_VIEW), { search: "", source: null, sort: "name", order: "asc", page: 1, pageSize: MOD_PAGE_SIZE });
  assert.equal(MOD_PAGE_SIZE, 50);
  assert.deepEqual(
    modListQuery({ search: "typed but not applied", applied: "  create ", source: "modrinth", sort: { key: "size", direction: "descending" }, page: 3 }),
    { search: "create", source: "modrinth", sort: "size", order: "desc", page: 3, pageSize: 50 },
    "the field's text waits for the pause; the request carries the applied search, trimmed",
  );
});

test("the live loader sends page, size, order and only the search and source that are set", async (t) => {
  const asked: string[] = [];
  const body = { release: "1.4", split: true, all: 6, total: 2, page: 2, pages: 3, pageSize: 2, sources: [{ source: "github", count: 1 }], mods: [{ file: "a.jar", sha256: "a".repeat(64), bytes: 1 }] };
  t.mock.method(globalThis, "fetch", async (url: string) => { asked.push(url); return new Response(JSON.stringify(body), { status: 200 }); });
  const page = await worldsApi.loadReleaseMods("minecraft", "prominence", "1.4", { search: "", source: null, sort: "name", order: "asc", page: 1, pageSize: 50 });
  await worldsApi.loadReleaseMods("minecraft", "prominence", "1.4", { search: "create mod", source: "unknown", sort: "size", order: "desc", page: 2, pageSize: 50 });
  const params = (url: string) => Object.fromEntries(new URL(url, "http://x").searchParams);
  assert.deepEqual(params(asked[0]!), { page: "1", pageSize: "50", sort: "name", order: "asc" });
  assert.deepEqual(params(asked[1]!), { page: "2", pageSize: "50", sort: "size", order: "desc", query: "create mod", source: "unknown" });
  assert.match(asked[0]!, /\/games\/minecraft\/presets\/prominence\/releases\/1\.4\?/);
  assert.deepEqual([page.split, page.all, page.total, page.page, page.pages, page.mods.length], [true, 6, 2, 2, 3, 1]);
});

test("a refused mod list is a failure that names the cause, not an empty list", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "invalid_mod_query" }), { status: 400 }));
  await assert.rejects(worldsApi.loadReleaseMods("minecraft", "prominence", "1.4", { search: "", source: null, sort: "name", order: "asc", page: 1, pageSize: 50 }), /mod search is not valid/);
});

test("releases compare as numbers, so 10.1 is newer than 9.3, and downloads list the newest first", () => {
  assert.ok(compareReleases("1.10", "1.9") > 0);
  assert.ok(compareReleases("10.1", "9.3") > 0);
  assert.ok(compareReleases("39127124115.1", "1.2") > 0);
  assert.equal(compareReleases("1.2", "1.2"), 0);
  assert.ok(compareReleases("latest", "1.0") < 0, "a name that is no number counts as older");
  const rows = [{ name: "1.2" }, { name: "1.10" }, { name: "1.9" }];
  assert.deepEqual(newestFirst(rows).map((row) => row.name), ["1.10", "1.9", "1.2"]);
  assert.deepEqual(rows.map((row) => row.name), ["1.2", "1.10", "1.9"], "the input is not reordered");
});

// The console's filter bar speaks in tokens; the model keeps one search and one source.
function recordingModel(over: Partial<ModsModel> = {}) {
  const calls: unknown[][] = [];
  const model = {
    release: "1.4", split: false, search: "", source: null, sort: { key: "name", direction: "ascending" }, page: 1, pages: 1, narrowed: false,
    sources: [{ source: "curseforge", label: "CurseForge", count: 3 }, { source: "unknown", label: "Unknown", count: 1 }],
    setSearch: (value: string) => calls.push(["search", value]),
    setSource: (source: unknown) => calls.push(["source", source]),
    setSort: noopSetter, setPage: noopSetter, clear: noopSetter, files: { status: "loading" },
    ...over,
  } as unknown as ModsModel;
  return { model, calls };
}
function noopSetter() { return undefined; }

test("the console filter bar sends the text token and the source token to the model, the last of each kind", () => {
  const { model, calls } = recordingModel();
  narrow(model, [{ property: null, value: "old" }, { property: "source", value: "Unknown" }, { property: null, value: "create" }, { property: "source", value: "CurseForge" }]);
  assert.deepEqual(calls, [["search", "create"], ["source", "curseforge"]]);
  calls.length = 0;
  narrow(model, []);
  assert.deepEqual(calls, [["search", ""], ["source", null]], "removing the tokens removes the search and the filter");
  calls.length = 0;
  narrow(model, [{ property: "source", value: "Unknown" }]);
  assert.deepEqual(calls, [["search", ""], ["source", "unknown"]], "unknown is a source to filter on");
});

test("the console filter bar shows what the model was asked for as tokens", () => {
  assert.deepEqual(tokensOf(recordingModel().model), []);
  assert.deepEqual(tokensOf(recordingModel({ search: " create ", source: "unknown" }).model), [{ property: null, value: "create" }, { property: "source", value: "Unknown" }]);
});
