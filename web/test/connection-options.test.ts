import assert from "node:assert/strict";
import test from "node:test";

import { connectionOptions } from "../src/core/forms.ts";

// ADR-0085: the persistent host serves any connection; ZeroTier stays off the fleet (ADR-0033).
test("the persistent host offers ZeroTier, a public address and DNS", () => {
  assert.deepEqual(connectionOptions("configured", true).map((option) => [option.value, option.disabled]), [["zerotier", false], ["raw", false], ["route53", false]]);
});

test("a fleet host offers only public connections, and says why ZeroTier is not one", () => {
  const options = connectionOptions("fleet", true);
  assert.deepEqual(options.map((option) => [option.value, option.disabled]), [["zerotier", true], ["raw", false], ["route53", false]]);
  assert.equal(options[0]?.hint, "Fleet hosts do not join ZeroTier");
});

test("DNS is offered only where the deployment has a DNS zone", () => {
  for (const placement of ["configured", "fleet"] as const) {
    assert.equal(connectionOptions(placement, false).some((option) => option.value === "route53"), false);
  }
});
