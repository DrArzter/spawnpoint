import "./support/browser.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmationCopy } from "../src/core/forms.ts";
import { stopDisconnect } from "../src/core/worlds.ts";
import type { Game, World, WorldSession } from "../src/model.ts";
import { deriveSharedHostSession } from "../src/session.ts";
import type { Confirmation } from "../src/shell/actions.ts";

// A stop with players online disconnects them only for a caller with session.stop.force.

function session(players: number | null): WorldSession {
  return {
    serverId: "world#prom", desiredState: "running", observedState: "ready", activeSessionId: "session-prom", activeWorldId: "prom",
    updatedAtEpochSeconds: 1, idle: players === null ? null : { playersOnline: players, consecutiveEmpty: 0, lastObservedAtEpochSeconds: 1 },
  };
}

function world(players: number | null): World {
  return {
    id: "prom", displayName: "Prominence", profileId: "prominence", sessionControlAvailable: true, connectivity: "route53", placement: "fleet", auth: "game",
    materialization: "existing", wipes: [], connectionAddress: null,
    preset: { id: "prominence", displayName: "Prominence II", repository: "https://github.com/x/y", commit: "a".repeat(40), profileDigest: "b".repeat(64), releases: ["1.0"], buildStatus: "ready", latestRelease: "1.0" },
    release: { state: "available", generationId: `gen-${"c".repeat(32)}`, desiredRelease: "1.0", activeRelease: "1.0" },
    session: session(players),
  };
}

const gameOf = (target: World): Game => ({ id: "minecraft", code: "MC", displayName: "Minecraft", lifecycle: null, presets: [], worlds: [target] });
const NONE = deriveSharedHostSession(null);
const FORCE = new Set(["session.stop", "session.stop.force"]);
const PLAIN = new Set(["session.stop"]);

test("a stop with players online disconnects them for a caller who may", () => {
  const target = world(2);
  assert.deepEqual(stopDisconnect(gameOf(target), target, "stop", FORCE, NONE), { disconnect: 2 });
});

test("a caller without session.stop.force, an empty world, an unread count and a start all get the plain request", () => {
  const busy = world(2);
  assert.deepEqual(stopDisconnect(gameOf(busy), busy, "stop", PLAIN, NONE), {});
  assert.deepEqual(stopDisconnect(gameOf(busy), busy, "start", FORCE, NONE), {});
  for (const players of [0, null]) {
    const target = world(players);
    assert.deepEqual(stopDisconnect(gameOf(target), target, "stop", FORCE, NONE), {});
  }
});

test("the stop confirmation says who it disconnects, and the plain one keeps its refusal", () => {
  const target = world(2);
  const base: Confirmation = { kind: "session", action: "stop", game: gameOf(target), world: target };
  const forced = confirmationCopy({ ...base, disconnect: 2 });
  assert.equal(forced.title, "Disconnect 2 players and stop?");
  assert.equal(forced.label, "Disconnect and stop");
  assert.equal(forced.destructive, true);
  assert.equal(confirmationCopy({ ...base, disconnect: 1 }).title, "Disconnect 1 player and stop?");
  const plain = confirmationCopy(base);
  assert.equal(plain.label, "Stop session");
  assert.match(plain.description, /Refused while players are online/);
});
