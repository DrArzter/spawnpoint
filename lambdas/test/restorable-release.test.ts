import assert from "node:assert/strict";
import test from "node:test";

process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.BOT_TOKEN_PARAMETER ??= "/spawnpoint/bot/token";
process.env.SESSION_SIGNING_SECRET_PARAMETER ??= "/spawnpoint/auth/session-signing-secret";
process.env.CONTROL_PLANE_VIEW_TABLE ??= "spawnpoint-control-plane-view-test";
process.env.CONTROL_PLANE_WEBSOCKET_URL ??= "wss://socket.example.test/live";
const { restorableRelease } = await import("../src/handlers/access-api.ts");

const current = "gen-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const previous = "gen-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const record = {
  worldId: "rostik",
  gameId: "minecraft",
  displayName: "Rostik",
  status: "active",
  connectivity: "zerotier",
  preset: { id: "industrial", repository: "https://github.com/x/y", commit: "a".repeat(40), profileDigest: "b".repeat(64) },
  currentGeneration: { id: current, release: "1.3", createdAt: "2026-09-14T00:00:00Z", source: { kind: "preset" } },
  previousGenerations: [
    { id: previous, release: "1.2", createdAt: "2026-09-01T00:00:00Z", closedAt: "2026-09-14T00:00:00Z", source: { kind: "preset" } },
  ],
} as Parameters<typeof restorableRelease>[0];

const key = (generationId: string) => `worlds/rostik/archives/rostik-${generationId}-20260914T173200Z-${"c".repeat(64)}.tar.zst`;

test("a backup restores when the release its generation ran is still published", async () => {
  const asked: string[] = [];
  const verdict = await restorableRelease(record, key(previous), async (game, preset, version) => {
    asked.push(`${game}/${preset}/${version}`);
    return { release: version };
  });
  assert.equal(verdict, "ok");
  // The release comes from the generation the backup was taken from, not from
  // whatever the world runs today.
  assert.deepEqual(asked, ["minecraft/industrial/1.2"]);
});

test("a backup whose release is gone is refused before the generation is written", async () => {
  const verdict = await restorableRelease(record, key(previous), async () => null);
  assert.equal(verdict, "release_missing");
});

test("a key naming a generation this world never had is refused", async () => {
  const verdict = await restorableRelease(record, key("gen-" + "d".repeat(32)), async () => ({}));
  assert.equal(verdict, "unknown_generation");
});

test("a key with no generation in it is refused", async () => {
  const verdict = await restorableRelease(record, "worlds/rostik/archives/legacy.tar.zst", async () => ({}));
  assert.equal(verdict, "unknown_generation");
});

test("a deployment with no manifest source does not block restores", async () => {
  assert.equal(await restorableRelease(record, key(current), undefined), "ok");
});
