import assert from "node:assert/strict";
import test from "node:test";

import { SYSTEM_RESERVE_MIB, shapeFits } from "../src/domain/placement.ts";
import { footprintForWorld, gameCatalog, gameFootprints, launchFamilies, launchRequirementsForWorld } from "../src/control-plane/catalog.ts";

test("every game in the catalog has a footprint, and every footprint is a whole number of MiB above zero", () => {
  for (const game of gameCatalog) {
    const footprint = game.footprint ?? gameFootprints[game.id];
    assert.ok(footprint, `${game.id} has no footprint`);
    assert.ok(Number.isSafeInteger(footprint.memoryMiB) && footprint.memoryMiB > 0, `${game.id} memory`);
    assert.ok(footprint.cores > 0, `${game.id} cores`);
  }
});

test("a world's footprint is its game's unless it says otherwise, field by field", () => {
  assert.deepEqual(footprintForWorld("world"), gameFootprints.minecraft);
  assert.deepEqual(footprintForWorld("vanilla"), { memoryMiB: 3 * 1024, cores: 0.5 });

  const catalog = [{
    id: "factorio", code: "FA", displayName: "Factorio", connectPort: 34197,
    worlds: [{ id: "big-base", displayName: "Big base", profileId: "p", sessionControl: "v1" as const, connectivity: "zerotier" as const, footprint: { memoryMiB: 4 * 1024 } }],
  }];
  assert.deepEqual(footprintForWorld("big-base", catalog), { memoryMiB: 4 * 1024, cores: 0.5 });
  assert.throws(() => footprintForWorld("nowhere", catalog), /unknown world/);
  assert.throws(
    () => footprintForWorld("w", [{ id: "chess", code: "CH", displayName: "Chess", connectPort: 1, worlds: [{ id: "w", displayName: "W", profileId: "p", sessionControl: null, connectivity: "zerotier" as const }] }]),
    /no footprint for game chess/,
  );
});

test("a launch asks for the footprint beside the system reserve, and the current host answers the modded world", () => {
  assert.deepEqual(launchRequirementsForWorld("world"), { memoryMiB: 7 * 1024 + SYSTEM_RESERVE_MIB, vcpu: 2 });
  assert.deepEqual(launchRequirementsForWorld("vanilla"), { memoryMiB: 3 * 1024 + SYSTEM_RESERVE_MIB, vcpu: 1 });
  // The shape the panel runs on today still holds its own world beside the reserve.
  assert.equal(shapeFits({ instanceType: "m7i-flex.large", memoryMiB: 8 * 1024, vcpu: 2 }, footprintForWorld("world")), true);
});

test("the allowed families are EC2 Fleet AllowedInstanceTypes patterns, x86 and never burstable", () => {
  assert.ok(launchFamilies.length > 0);
  for (const pattern of launchFamilies) {
    assert.match(pattern, /^[a-z][a-z0-9]*(-[a-z]+)?\.\*$/, pattern);
    assert.equal(pattern.startsWith("t"), false, `${pattern} is burstable`);
    assert.equal(/g\./.test(pattern) || /^[a-z]\d+g/.test(pattern), false, `${pattern} is Graviton`);
  }
});
