import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { visibleNavigation } from "../src/core/navigation.ts";
import { worldTabs } from "../src/core/worlds.ts";
import type { World } from "../src/model.ts";

const granted = new Set(["status.read", "metrics.read", "console.use", "release.read", "access.read"]);

test("the menu names what belongs to the whole deployment, never one world's console or metrics", () => {
  // ADR-0062: several worlds of a game can run at once, each on its own host,
  // so a console or a host's metrics in the menu could only guess which world.
  const pages = visibleNavigation(granted, new Set(["worldMetrics", "consoleGateway"])).map((item) => item.id);
  assert.deepEqual(pages, ["worlds", "releases", "access"]);
});

test("a served route does not grant access without permission", () => {
  const pages = visibleNavigation(new Set(["status.read"]), new Set(["consoleGateway"])).map((item) => item.id);
  assert.deepEqual(pages, ["worlds"]);
});

const world: World = {
  id: "rostik", displayName: "Rostik", profileId: "industrial", sessionControlAvailable: true, connectivity: "route53", placement: "fleet",
  materialization: "existing", worldLifecycleAvailable: true, wipes: [], preset: null, connectionAddress: null,
  release: { state: "available", generationId: null, desiredRelease: "1.2", activeRelease: "1.2" },
};

test("a world offers its console and its host's metrics as tabs, when the role and the deployment do", () => {
  const ids = (offered: Parameters<typeof worldTabs>[1]) => worldTabs(world, offered).map((tab) => tab.id);
  assert.deepEqual(ids({ releases: true, whitelist: true, console: true, metrics: true }), ["details", "wipes", "backups", "releases", "whitelist", "console", "metrics"]);
  assert.deepEqual(ids({ releases: true, whitelist: false, console: false, metrics: false }), ["details", "wipes", "backups", "releases"]);
});
