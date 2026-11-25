import assert from "node:assert/strict";
import test from "node:test";

import { SYSTEM_RESERVE_MIB, requirementsFor, shapeFits } from "../src/domain/placement.ts";
import { gameCatalog, gameFootprints, launchFamilies } from "../src/control-plane/catalog.ts";

test("every game in the catalog has a footprint, and every footprint is a whole number of MiB above zero", () => {
  for (const game of gameCatalog) {
    const footprint = game.footprint ?? gameFootprints[game.id];
    assert.ok(footprint, `${game.id} has no footprint`);
    assert.ok(Number.isSafeInteger(footprint.memoryMiB) && footprint.memoryMiB > 0, `${game.id} memory`);
    assert.ok(footprint.cores > 0, `${game.id} cores`);
  }
});

test("a launch asks for the game's footprint beside the system reserve, and the current host answers the modded game", () => {
  assert.deepEqual(requirementsFor(gameFootprints.minecraft!), { memoryMiB: 7 * 1024 + SYSTEM_RESERVE_MIB, vcpu: 2 });
  // The shape the panel runs on today still holds its own world beside the reserve.
  assert.equal(shapeFits({ instanceType: "m7i-flex.large", memoryMiB: 8 * 1024, vcpu: 2 }, gameFootprints.minecraft!), true);
});

test("the allowed families are EC2 Fleet AllowedInstanceTypes patterns, x86 and never burstable", () => {
  assert.ok(launchFamilies.length > 0);
  for (const pattern of launchFamilies) {
    assert.match(pattern, /^[a-z][a-z0-9]*(-[a-z]+)?\.\*$/, pattern);
    assert.equal(pattern.startsWith("t"), false, `${pattern} is burstable`);
    assert.equal(/g\./.test(pattern) || /^[a-z]\d+g/.test(pattern), false, `${pattern} is Graviton`);
  }
});
