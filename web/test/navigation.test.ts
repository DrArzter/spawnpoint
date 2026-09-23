import assert from "node:assert/strict";
import test from "node:test";

import { visibleNavigation } from "../src/core/navigation.ts";

const granted = new Set(["status.read", "metrics.read", "console.use", "release.read", "access.read"]);

test("unfinished console is absent from a live deployment despite permission", () => {
  const pages = visibleNavigation(granted, new Set(["hostMetrics"])).map((item) => item.id);
  assert.deepEqual(pages, ["worlds", "metrics", "releases", "access"]);
});

test("demo can still explore the console prototype", () => {
  const pages = visibleNavigation(granted, new Set(["hostMetrics", "consoleGateway"])).map((item) => item.id);
  assert.deepEqual(pages, ["worlds", "metrics", "console", "releases", "access"]);
});

test("a permission does not expose an unserved metrics page", () => {
  const pages = visibleNavigation(granted, new Set()).map((item) => item.id);
  assert.deepEqual(pages, ["worlds", "releases", "access"]);
});

test("a served route does not grant access without permission", () => {
  const pages = visibleNavigation(new Set(["status.read"]), new Set(["hostMetrics", "consoleGateway"])).map((item) => item.id);
  assert.deepEqual(pages, ["worlds"]);
});
