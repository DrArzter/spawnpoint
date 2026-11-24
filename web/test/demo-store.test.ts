import "./support/browser.ts";

import assert from "node:assert/strict";
import { mock, test } from "node:test";

import * as store from "../src/demo/store.ts";
import type { ControlPlaneSnapshot } from "../src/model.ts";
import { configuredHosts, deriveSharedHostSession, worldState } from "../src/session.ts";

// The demo models ADR-0062: a fleet world starts on a host launched for it and
// waits only for its own operations; configured worlds share the one configured
// host, which runs one session at a time. The store keeps one control plane per
// module, so these tests run in order against it.

mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-21T12:00:00.000Z") });

const GAME = "minecraft";
const ROSTIK = "minecraft-rostik-12345678";
const VANILLA = "vanilla";
const CREATIVE = "minecraft-creative-5e1c9a07";
const SANDBOX = "minecraft-sandbox-8d41f0b6";

function stateOf(snapshot: ControlPlaneSnapshot, worldId: string) {
  const game = snapshot.games.find((item) => item.id === GAME)!;
  return worldState(game, game.worlds.find((item) => item.id === worldId)!, deriveSharedHostSession(snapshot));
}

let skyline = "";

test("the demo deploys fleet worlds by default and seeds one beside the configured worlds", () => {
  const snapshot = store.snapshot();
  assert.equal(snapshot.deployment?.placement, "fleet");
  assert.equal(snapshot.deployment?.launchEnabled, true);
  const worlds = snapshot.games.find((item) => item.id === GAME)!.worlds;
  assert.deepEqual(worlds.filter((item) => item.placement === "fleet").map((item) => item.id), [CREATIVE, SANDBOX]);
  assert.deepEqual(worlds.filter((item) => item.placement === "configured").map((item) => item.id), [ROSTIK, VANILLA]);
  assert.equal(stateOf(snapshot, ROSTIK), "running");
  assert.equal(stateOf(snapshot, CREATIVE), "stopped");
  const sandbox = worlds.find((item) => item.id === SANDBOX)!;
  assert.deepEqual([sandbox.release.activeRelease, sandbox.release.runCount], [null, 0], "a never-started world shows Update release enabled");
});

test("two fleet worlds of a game start one after the other, each on a host of its own", () => {
  skyline = store.createWorld(GAME, "industrial", "Skyline", "1.3", "fleet", "raw", "game").id;

  const first = store.startSession(GAME, CREATIVE);
  const second = store.startSession(GAME, skyline);

  let snapshot = store.snapshot();
  assert.deepEqual(snapshot.operations.map((operation) => [operation.id, operation.worldId]), [[first.operationId, CREATIVE], [second.operationId, skyline]]);
  const launched = snapshot.hosts.filter((host) => host.provenance === "launched");
  assert.deepEqual(launched.map((host) => [host.id, host.state]), [[`host-${CREATIVE}`, "pending"], [`host-${skyline}`, "pending"]]);
  assert.deepEqual(configuredHosts(snapshot).map((host) => [host.id, host.state]), [["host-game", "running"]]);
  assert.equal(stateOf(snapshot, CREATIVE), "starting");
  assert.equal(stateOf(snapshot, skyline), "starting");
  // The configured world keeps its session on the shared host.
  assert.equal(stateOf(snapshot, ROSTIK), "running");

  mock.timers.tick(7000);
  snapshot = store.snapshot();
  assert.deepEqual(snapshot.operations, []);
  assert.equal(stateOf(snapshot, CREATIVE), "running");
  assert.equal(stateOf(snapshot, skyline), "running");
  assert.ok(snapshot.hosts.filter((host) => host.provenance === "launched").every((host) => host.state === "running" && host.launchedAt !== null));
  assert.notEqual(store.worldMetrics(GAME, skyline, "6h"), null);
  assert.ok(store.worldMetrics(GAME, skyline, "6h")?.series.some((series) => series.id === "memory"), "the demo draws memory beside CPU");
  const running = store.worldMetrics(GAME, skyline, "6h")!;
  assert.ok(running.pendingFrom !== undefined, "a running session's newest slots are not reported yet");
  const memory = running.series.find((series) => series.id === "memory")!.points;
  assert.ok(memory.some((point) => point.interpolated === true), "memory is joined between its 15-minute probes");
  assert.ok(memory.filter((point) => point.interpolated !== true && point.value !== null).length > 1);
  const fleetWorld = snapshot.games.find((item) => item.id === GAME)!.worlds.find((item) => item.id === skyline)!;
  assert.equal(fleetWorld.session?.readyAtEpochSeconds, Date.parse("2026-11-21T12:00:07.000Z") / 1000, "a session says when it became ready");
  assert.throws(() => store.startSession(GAME, CREATIVE), /already running/);
});

test("a fleet world waits only for its own operation", () => {
  store.stopSession(GAME, CREATIVE);
  assert.throws(() => store.startSession(GAME, CREATIVE), /Another control-plane operation/);
  assert.throws(() => store.worldLifecycle(GAME, CREATIVE, "archive"), /Another control-plane operation/);
  // Another fleet world and the configured worlds are not held back by it.
  assert.doesNotThrow(() => store.updateWhitelist(GAME, skyline, ["Steve"]));

  mock.timers.tick(6000);
  const snapshot = store.snapshot();
  assert.equal(stateOf(snapshot, CREATIVE), "stopped");
  assert.deepEqual(snapshot.hosts.map((host) => host.id), ["host-game", `host-${skyline}`]);
  // A stopped fleet world keeps its history: an earlier session on one host, a later one on another.
  const history = store.worldMetrics(GAME, CREATIVE, "24h");
  const cpu = history?.series.find((series) => series.id === "cpu")?.points ?? [];
  const runs = cpu.reduce((count, point, index) => count + (point.value !== null && (index === 0 || cpu[index - 1]?.value === null) ? 1 : 0), 0);
  assert.equal(runs, 2, "two sessions with a gap between them");
  assert.equal(history?.pendingFrom, undefined, "nothing runs, so nothing is pending");
  assert.equal(store.worldMetrics(GAME, ROSTIK, "6h") === null, false, "the configured world still holds its session");
});

test("a configured sibling is refused while another configured world of the game runs", () => {
  assert.throws(() => store.startSession(GAME, VANILLA), /The shared host already runs Minecraft/);

  store.stopSession(GAME, ROSTIK);
  // The configured world's stop holds its configured siblings, not fleet worlds.
  assert.throws(() => store.startSession(GAME, VANILLA), /Another control-plane operation/);
  assert.doesNotThrow(() => store.startSession(GAME, CREATIVE));

  mock.timers.tick(7000);
  const snapshot = store.snapshot();
  assert.equal(stateOf(snapshot, ROSTIK), "stopped");
  assert.equal(stateOf(snapshot, CREATIVE), "running");
  assert.equal(configuredHosts(snapshot)[0]?.state, "stopped");
  // With the configured host free, the sibling starts there.
  assert.doesNotThrow(() => store.startSession(GAME, VANILLA));
});

test("archiving a running fleet world stops its session and removes its launched host", () => {
  mock.timers.tick(7000);
  assert.equal(stateOf(store.snapshot(), skyline), "running");

  store.worldLifecycle(GAME, skyline, "archive");
  mock.timers.tick(4000);
  let snapshot = store.snapshot();
  const archived = snapshot.games.find((item) => item.id === GAME)!.worlds.find((item) => item.id === skyline)!;
  assert.equal(archived.materialization, "archived");
  assert.equal(archived.session?.observedState, "stopped");
  assert.equal(archived.session?.activeSessionId, null);
  assert.equal(stateOf(snapshot, skyline), "stopped");
  assert.equal(snapshot.hosts.some((host) => host.id === `host-${skyline}`), false);
  assert.equal(store.worldMetrics(GAME, skyline, "6h"), null);

  // Purge never leaves a launched host behind either.
  store.worldLifecycle(GAME, skyline, "purge");
  mock.timers.tick(4000);
  snapshot = store.snapshot();
  assert.equal(snapshot.games.find((item) => item.id === GAME)!.worlds.some((item) => item.id === skyline), false);
  assert.equal(snapshot.hosts.some((host) => host.id === `host-${skyline}`), false);
});

test("a world with no list of its own shows its running server's, none once stopped, and adding a name keeps those players (ADR-0066)", () => {
  assert.equal(stateOf(store.snapshot(), CREATIVE), "running");
  const read = store.whitelist(GAME, CREATIVE);
  assert.deepEqual(read, { managed: false, names: ["DrArzter", "Mira"], updatedAt: null, updatedBy: null });
  store.stopSession(GAME, CREATIVE);
  mock.timers.tick(7000);
  assert.deepEqual(store.whitelist(GAME, CREATIVE), { managed: false, names: [], updatedAt: null, updatedBy: null }, "a stopped world has no server to read");
  const saved = store.updateWhitelist(GAME, CREATIVE, [...read.names, "Kira"]);
  assert.deepEqual(saved.names, ["DrArzter", "Mira", "Kira"]);
  assert.equal(store.whitelist(GAME, CREATIVE).managed, true);
});

test("a fleet world's promotion keeps its wipe, names the target as desired, and commits it once the operation ends (ADR-0078)", () => {
  assert.equal(stateOf(store.snapshot(), CREATIVE), "stopped");
  const creative = () => store.snapshot().games.find((item) => item.id === GAME)!.worlds.find((item) => item.id === CREATIVE)!;
  const wipe = creative().release.generationId;
  const from = creative().release.activeRelease!;
  const to = creative().preset!.releases.at(-1)!;
  const older = creative().preset!.releases[0]!;
  assert.throws(() => store.promoteWorld(GAME, CREATIVE, from), /already active/);
  assert.throws(() => store.promoteWorld(GAME, CREATIVE, older), /older than the active one/, "going back is a restore, as in the API");
  assert.throws(() => store.promoteWorld(GAME, ROSTIK, to), /fleet world/);
  store.promoteWorld(GAME, CREATIVE, to);
  assert.deepEqual([creative().release.desiredRelease, creative().release.activeRelease], [to, from]);
  assert.ok(store.snapshot().operations.some((operation) => operation.type === "promote" && operation.worldId === CREATIVE));
  mock.timers.tick(7000);
  assert.deepEqual([creative().release.desiredRelease, creative().release.activeRelease, creative().release.generationId], [to, to, wipe]);
});

test("the demo names where each mod of a release came from, except for a preset's first release (built before sources)", () => {
  const first = store.releaseMods(GAME, "industrial", "1.1");
  assert.ok(first.mods.every((mod) => mod.source === undefined), "an older release has no source");
  const later = store.releaseMods(GAME, "industrial", "1.3");
  assert.deepEqual([...new Set(later.mods.map((mod) => mod.source))].sort(), ["curseforge", "github", "modrinth"]);
  assert.ok((store.releaseMods(GAME, "industrial", "1.2").clientMods ?? []).every((mod) => mod.source !== undefined));
});

test("the demo pages, searches, filters and sorts a release's mods as the API does", () => {
  const ask = (over: Partial<Parameters<typeof store.releaseModPage>[3]> = {}) => store.releaseModPage(GAME, "industrial", "1.3", { search: "", source: null, sort: "name", order: "asc", page: 1, pageSize: 50, ...over });
  const files = (page: ReturnType<typeof ask>) => page.mods.map((mod) => mod.file);
  const everything = ask();
  assert.deepEqual([everything.all, everything.total, everything.pages, everything.split], [10, 10, 1, true]);
  assert.deepEqual(files(ask({ page: 2, pageSize: 4 })).length, 4);
  assert.deepEqual([ask({ page: 9, pageSize: 4 }).page, ask({ page: 9, pageSize: 4 }).pages], [3, 3], "a page past the end falls back to the last");
  assert.deepEqual(files(ask({ search: "MEKANISM" })), ["Mekanism-1.20.1-10.4.15.75.jar"]);
  assert.ok(ask({ source: "modrinth" }).mods.every((mod) => mod.source === "modrinth"));
  assert.deepEqual(everything.sources.map((entry) => entry.source), ["curseforge", "modrinth", "github"]);
  const bySize = files(ask({ sort: "size", order: "desc" }));
  assert.deepEqual([bySize[0], bySize.at(-1)], ["create-1.20.1-0.5.1.j.jar", "Jade-1.20.1-Forge-11.12.3.jar"]);
  const old = store.releaseModPage(GAME, "industrial", "1.1", { search: "", source: null, sort: "name", order: "asc", page: 1, pageSize: 50 });
  assert.deepEqual([old.sources, old.split], [[], false], "an older release records no source and offers no filter");
});

test("a never-started world switches its release at once, with no operation, and a start commits the release it names (ADR-0078)", () => {
  const created = store.createWorld(GAME, "industrial", "Sandbox", "1.2", "fleet", "raw", "game").id;
  const sandbox = () => store.snapshot().games.find((item) => item.id === GAME)!.worlds.find((item) => item.id === created)!;
  assert.deepEqual([sandbox().release.activeRelease, sandbox().release.runCount, sandbox().release.desiredRelease], [null, 0, "1.2"]);
  assert.throws(() => store.promoteWorld(GAME, created, "1.2"), /already selected/);
  assert.throws(() => store.promoteWorld(GAME, created, "9.9"), /no longer available/);
  const operations = store.snapshot().operations.length;
  assert.deepEqual(store.promoteWorld(GAME, created, "1.1"), { result: "switched" });
  assert.equal(store.snapshot().operations.length, operations, "no workflow runs");
  assert.deepEqual([sandbox().release.activeRelease, sandbox().release.desiredRelease, sandbox().wipes[0]!.originRelease], [null, "1.1", "1.1"]);
  assert.equal(store.backups(GAME, created).entries.length, 0);

  store.startSession(GAME, created);
  assert.throws(() => store.promoteWorld(GAME, created, "1.3"), /Another control-plane operation/);
  mock.timers.tick(7000);
  assert.deepEqual([sandbox().release.activeRelease, sandbox().release.runCount], ["1.1", 1]);
  assert.equal(store.promoteWorld(GAME, created, "1.3").result, "requested", "once it ran, the promotion path applies");
});

test("a world's config files list the release's files and the world's edit, and keep a save, a reset and a stale save honest (ADR-0093)", () => {
  const listed = store.configFiles(GAME, ROSTIK);
  assert.equal(listed.release, "1.3");
  const claims = listed.files.find((file) => file.path === "config/claims.toml")!;
  assert.equal(claims.source, "world", "the seeded world edit");
  assert.equal(claims.releaseChanged, true);
  assert.equal(listed.files.find((file) => file.path === "config/large.bin")!.editable, false);
  assert.throws(() => store.configFile(GAME, ROSTIK, "config/large.bin"), { code: "config_file_not_editable" });
  const server = store.configFile(GAME, ROSTIK, "config/mod/server.toml");
  assert.equal(server.source, "release");
  // A save names the digest it loaded; the next one with that digest is stale.
  const saved = store.saveConfigFile(GAME, ROSTIK, server.path, `${server.text}# tuned\n`, server.sha256);
  assert.throws(() => store.saveConfigFile(GAME, ROSTIK, server.path, "other", server.sha256), { code: "config_file_changed" });
  const edited = store.configFiles(GAME, ROSTIK).files.find((file) => file.path === server.path)!;
  assert.equal(edited.source, "world");
  assert.equal(edited.worldSha256, saved.sha256);
  assert.throws(() => store.resetConfigFile(GAME, ROSTIK, server.path, "stale"), { code: "config_file_changed" });
  store.resetConfigFile(GAME, ROSTIK, server.path, saved.sha256);
  assert.equal(store.configFiles(GAME, ROSTIK).files.find((file) => file.path === server.path)!.source, "release");
  // Saving the release's own text removes the edit; a new file under a root is the world's own.
  const reloaded = store.configFile(GAME, ROSTIK, claims.path);
  store.saveConfigFile(GAME, ROSTIK, claims.path, "[claims]\nmax_chunks = 100\nallow_pvp = true\n", reloaded.sha256);
  assert.equal(store.configFiles(GAME, ROSTIK).files.find((file) => file.path === claims.path)!.source, "release");
  store.saveConfigFile(GAME, ROSTIK, "config/new.toml", "a = 1\n", null);
  assert.equal(store.configFiles(GAME, ROSTIK).files.find((file) => file.path === "config/new.toml")!.source, "world_only");
  assert.throws(() => store.saveConfigFile(GAME, ROSTIK, "elsewhere/new.toml", "a", null), { code: "invalid_config_path" });
});

test("a game with no config rules lists no files in the demo", () => {
  assert.deepEqual(store.configFiles("factorio", "factorio"), { release: null, roots: [], maxBytes: 0, files: [] });
});
