import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { persistentHostNotice, unusedPersistentHost } from "../src/core/hosts.ts";
import { confirmationCopy } from "../src/core/forms.ts";
import { initialState } from "../src/demo/data.ts";
import { fleetOnlyState } from "../src/demo/fleet-only.ts";
import type { ControlPlaneSnapshot } from "../src/model.ts";

// ADR-0100: a persistent host no world is placed on is offered for deletion.

const mixed = initialState().snapshot as unknown as ControlPlaneSnapshot;
const fleet = fleetOnlyState().snapshot as unknown as ControlPlaneSnapshot;

test("the host is offered only once no live world is placed on it", () => {
  assert.equal(unusedPersistentHost(mixed), null, "the demo's configured worlds still use it");
  const host = unusedPersistentHost(fleet);
  assert.equal(host?.stopped, true);
  assert.equal(unusedPersistentHost({ ...fleet, hosts: fleet.hosts.filter((item) => item.provenance === "launched") }), null, "a deleted host is not offered again");
});

test("the notice carries one Delete host action, for a role and deployment that can delete", () => {
  const asked: string[] = [];
  const notice = persistentHostNotice(fleet, true, (host) => asked.push(host.name));
  assert.equal(notice?.action?.id, "host.delete");
  assert.equal(notice?.action?.disabled, false);
  notice?.action?.run();
  assert.equal(asked.length, 1);
  assert.equal(persistentHostNotice(fleet, false, () => undefined), null, "without host.manage or the route, nothing is offered");
  const running = { ...fleet, hosts: fleet.hosts.map((item) => item.provenance === "launched" ? item : { ...item, state: "running" as const }) };
  assert.equal(persistentHostNotice(running, true, () => undefined)?.action?.disabled, true, "a running host is stopped first");
});

test("the dialog says what goes and that it cannot be undone", () => {
  const copy = confirmationCopy({ kind: "delete-host", host: { providerRef: "i-0123456789abcdef0", name: "spawnpoint-game-host" } });
  assert.equal(copy.destructive, true);
  assert.match(copy.description, /cannot be undone/);
});
